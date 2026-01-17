const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.static('public'));

const WORLD_W = 2000, WORLD_H = 2000;
const TICK_RATE = 60; // 60FPSに戻す（滑らかさのため）
const MAX_ENEMIES = 50;
const MAX_ENEMY_BULLETS = 100;
const MAX_ITEMS = 30;
const RESPAWN_TIME = 300; // 5秒（60fps * 5）

const ENEMY_TYPES = {
    small:  { hp: 3,  speed: 2,   size: 8,  color: '#0f0', score: 10 },
    medium: { hp: 8,  speed: 1.5, size: 14, color: '#ff0', score: 30 },
    large:  { hp: 20, speed: 1,   size: 22, color: '#f80', score: 50 },
    tank:   { hp: 40, speed: 0.8, size: 30, color: '#f00', score: 100 }
};

const BOSS_TYPES = [
    { name: 'BOSS-α', hp: 150,  size: 45, color: '#0ff', speed: 1.5 },
    { name: 'BOSS-β', hp: 300,  size: 55, color: '#f0f', speed: 1.8 },
    { name: 'BOSS-γ', hp: 500,  size: 65, color: '#ff0', speed: 2.0 },
    { name: 'BOSS-δ', hp: 800,  size: 75, color: '#f00', speed: 2.2 },
    { name: 'BOSS-Ω', hp: 1200, size: 90, color: '#fff', speed: 2.5 }
];

const rooms = new Map();

class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = new Map();
        this.enemies = [];
        this.enemyBullets = [];
        this.items = [];
        this.wave = 0;
        this.score = 0;
        this.state = 'waiting';
        this.frame = 0;
        this.idCounter = 0;
        this.boss = null;
        this.killCount = 0;
    }
    
    addPlayer(socket, name, isHost = false) {
        const player = {
            id: socket.id,
            name: name,
            x: WORLD_W / 2 + (Math.random() - 0.5) * 200,
            y: WORLD_H / 2 + (Math.random() - 0.5) * 200,
            angle: -Math.PI / 2,
            hp: 100,
            maxHp: 100,
            alive: true,
            score: 0,
            isHost: isHost,
            invincible: 180,
            dashing: false,
            respawnTimer: 0,
            weapons: { gatling: 1, fannel: 0, missile: 0, laser: 0, dash: 1 },
            autoFire: { gatling: false, fannel: false, missile: false, laser: false },
            fannels: [],
            input: { dx: 0, dy: 0, dashing: false }
        };
        this.players.set(socket.id, player);
        return player;
    }
    
    start() {
        this.state = 'playing';
        this.wave = 0;
        this.score = 0;
        this.killCount = 0;
        this.enemies = [];
        this.enemyBullets = [];
        this.items = [];
        this.boss = null;
        this.startWave();
        if (!this.loopInterval) {
            this.loopInterval = setInterval(() => this.update(), 1000 / TICK_RATE);
        }
    }
    
    startWave() {
        this.wave++;
        this.killCount = 0;
        this.boss = null;
        
        if (this.wave % 5 === 0) {
            const bossIdx = Math.min(Math.floor(this.wave / 5) - 1, BOSS_TYPES.length - 1);
            const t = BOSS_TYPES[bossIdx];
            this.boss = {
                id: 'boss_' + this.idCounter++,
                x: WORLD_W / 2, y: 200,
                hp: t.hp, maxHp: t.hp, size: t.size, color: t.color, speed: t.speed, name: t.name, timer: 0
            };
            io.to(this.id).emit('bossSpawn', { name: t.name });
        }
        io.to(this.id).emit('waveStart', { wave: this.wave });
    }
    
    update() {
        if (this.state !== 'playing') return;
        this.frame++;
        
        this.players.forEach(p => {
            if (p.alive) {
                if (p.invincible > 0) p.invincible--;
                
                const dashLevel = p.weapons.dash || 1;
                const baseSpeed = 5;
                const dashSpeed = baseSpeed + dashLevel * 0.6;
                const speed = p.input.dashing ? dashSpeed : baseSpeed;
                
                p.x += p.input.dx * speed;
                p.y += p.input.dy * speed;
                p.x = Math.max(30, Math.min(WORLD_W - 30, p.x));
                p.y = Math.max(30, Math.min(WORLD_H - 30, p.y));
                p.dashing = p.input.dashing;
                
                if (p.input.dx !== 0 || p.input.dy !== 0) {
                    p.angle = Math.atan2(p.input.dy, p.input.dx);
                }
                
                this.updateFannels(p);
            } else {
                // リスポーン処理
                p.respawnTimer++;
                if (p.respawnTimer >= RESPAWN_TIME) {
                    this.respawnPlayer(p);
                }
            }
        });
        
        if (!this.boss && this.frame % 45 === 0) this.spawnEnemy();
        this.updateEnemies();
        if (this.boss) this.updateBoss();
        this.updateBullets();
        this.updateItems();
        
        const killsNeeded = 15 + this.wave * 3;
        if (!this.boss && this.killCount >= killsNeeded) {
            this.startWave();
        }
        
        if (this.frame % 2 === 0) this.broadcast();
    }
    
    respawnPlayer(p) {
        p.alive = true;
        p.hp = p.maxHp;
        p.x = WORLD_W / 2 + (Math.random() - 0.5) * 200;
        p.y = WORLD_H / 2 + (Math.random() - 0.5) * 200;
        p.invincible = 180; // 3秒無敵
        p.respawnTimer = 0;
        // 武器レベルは維持（リセットしない）
        io.to(p.id).emit('respawned');
    }
    
    updateFannels(player) {
        const level = player.weapons.fannel;
        if (level <= 0) { player.fannels = []; return; }
        
        while (player.fannels.length < level) {
            player.fannels.push({ angle: Math.random() * Math.PI * 2, dist: 50 + Math.random() * 30 });
        }
        while (player.fannels.length > level) player.fannels.pop();
        
        player.fannels.forEach(f => { f.angle += 0.03; });
        
        if (player.autoFire.fannel && this.frame % 15 === 0) {
            player.fannels.forEach(f => {
                const fx = player.x + Math.cos(f.angle) * f.dist;
                const fy = player.y + Math.sin(f.angle) * f.dist;
                let target = null, minDist = 300;
                this.enemies.forEach(e => {
                    const d = Math.hypot(e.x - fx, e.y - fy);
                    if (d < minDist) { minDist = d; target = e; }
                });
                if (this.boss) {
                    const d = Math.hypot(this.boss.x - fx, this.boss.y - fy);
                    if (d < minDist) target = this.boss;
                }
                if (target) {
                    target.hp -= 2 + level;
                    io.to(this.id).emit('fannelShot', { x: fx, y: fy, tx: target.x, ty: target.y });
                }
            });
        }
    }
    
    spawnEnemy() {
        if (this.enemies.length >= MAX_ENEMIES) return;
        const types = Object.keys(ENEMY_TYPES);
        const weights = [50, 30, 15, 5];
        let roll = Math.random() * 100, typeIdx = 0;
        for (let i = 0; i < weights.length; i++) { roll -= weights[i]; if (roll <= 0) { typeIdx = i; break; } }
        const type = types[Math.min(typeIdx, types.length - 1)];
        const t = ENEMY_TYPES[type];
        
        let x, y;
        if (Math.random() < 0.5) { x = Math.random() < 0.5 ? 50 : WORLD_W - 50; y = Math.random() * WORLD_H; }
        else { x = Math.random() * WORLD_W; y = Math.random() < 0.5 ? 50 : WORLD_H - 50; }
        
        const scale = 1 + this.wave * 0.05;
        this.enemies.push({
            id: 'e_' + this.idCounter++, type, x, y,
            hp: Math.floor(t.hp * scale), maxHp: Math.floor(t.hp * scale),
            speed: t.speed, size: t.size, color: t.color, score: t.score
        });
    }
    
    updateEnemies() {
        this.enemies = this.enemies.filter(e => e.hp > 0);
        let tx = WORLD_W / 2, ty = WORLD_H / 2;
        this.players.forEach(p => { if (p.alive) { tx = p.x; ty = p.y; } });
        
        this.enemies.forEach(e => {
            const a = Math.atan2(ty - e.y, tx - e.x);
            e.x += Math.cos(a) * e.speed;
            e.y += Math.sin(a) * e.speed;
            
            this.players.forEach(p => {
                if (!p.alive || p.invincible > 0) return;
                if (Math.hypot(p.x - e.x, p.y - e.y) < 15 + e.size) {
                    p.hp -= 10; p.invincible = 60;
                    if (p.hp <= 0) { p.alive = false; p.respawnTimer = 0; io.to(p.id).emit('died'); }
                }
            });
        });
    }
    
    updateBoss() {
        if (!this.boss) return;
        if (this.boss.hp <= 0) {
            this.score += 500 * this.wave;
            this.dropItem(this.boss.x, this.boss.y, true);
            io.to(this.id).emit('bossDefeated', { wave: this.wave });
            this.boss = null;
            setTimeout(() => { if (this.state === 'playing') this.startWave(); }, 2000);
            return;
        }
        
        this.boss.timer++;
        let tx = WORLD_W / 2, ty = WORLD_H / 2;
        this.players.forEach(p => { if (p.alive) { tx = p.x; ty = p.y; } });
        
        const a = Math.atan2(ty - this.boss.y, tx - this.boss.x);
        this.boss.x += Math.cos(a) * this.boss.speed * 0.5;
        this.boss.y += Math.sin(a) * this.boss.speed * 0.5;
        this.boss.x = Math.max(100, Math.min(WORLD_W - 100, this.boss.x));
        this.boss.y = Math.max(100, Math.min(WORLD_H - 100, this.boss.y));
        
        if (this.boss.timer % 60 === 0 && this.enemyBullets.length < MAX_ENEMY_BULLETS) {
            for (let i = 0; i < 8; i++) {
                const ba = (Math.PI * 2 / 8) * i + this.boss.timer * 0.02;
                this.enemyBullets.push({ x: this.boss.x, y: this.boss.y, vx: Math.cos(ba) * 3, vy: Math.sin(ba) * 3, life: 180 });
            }
        }
        
        this.players.forEach(p => {
            if (!p.alive || p.invincible > 0) return;
            if (Math.hypot(p.x - this.boss.x, p.y - this.boss.y) < 20 + this.boss.size) {
                p.hp -= 20; p.invincible = 90;
                if (p.hp <= 0) { p.alive = false; p.respawnTimer = 0; io.to(p.id).emit('died'); }
            }
        });
    }
    
    updateBullets() {
        this.enemyBullets = this.enemyBullets.filter(b => {
            b.x += b.vx; b.y += b.vy; b.life--;
            if (b.life <= 0 || b.x < 0 || b.x > WORLD_W || b.y < 0 || b.y > WORLD_H) return false;
            let hit = false;
            this.players.forEach(p => {
                if (!p.alive || p.invincible > 0) return;
                if (Math.hypot(p.x - b.x, p.y - b.y) < 12) {
                    p.hp -= 8; p.invincible = 30; hit = true;
                    if (p.hp <= 0) { p.alive = false; p.respawnTimer = 0; io.to(p.id).emit('died'); }
                }
            });
            return !hit;
        });
    }
    
    updateItems() {
        this.items = this.items.filter(item => {
            let collected = false;
            this.players.forEach(p => {
                if (!p.alive) return;
                if (Math.hypot(p.x - item.x, p.y - item.y) < 30) {
                    collected = true;
                    this.collectItem(p, item);
                }
            });
            return !collected;
        });
    }
    
    collectItem(player, item) {
        switch (item.type) {
            case 'HP': player.hp = Math.min(player.maxHp, player.hp + 20); break;
            case 'GATLING': player.weapons.gatling = Math.min(10, player.weapons.gatling + 1); break;
            case 'FANNEL': player.weapons.fannel = Math.min(10, player.weapons.fannel + 1); break;
            case 'MISSILE': player.weapons.missile = Math.min(10, player.weapons.missile + 1); break;
            case 'LASER': player.weapons.laser = Math.min(10, player.weapons.laser + 1); break;
            case 'DASH': player.weapons.dash = Math.min(10, player.weapons.dash + 1); break;
        }
        io.to(player.id).emit('itemCollected', { type: item.type });
    }
    
    dropItem(x, y, isBoss = false) {
        if (this.items.length >= MAX_ITEMS) return;
        const types = ['HP', 'GATLING', 'FANNEL', 'MISSILE', 'LASER', 'DASH'];
        if (isBoss) {
            for (let i = 0; i < 3; i++) {
                this.items.push({ id: 'i_' + this.idCounter++, x: x + (Math.random() - 0.5) * 60, y: y + (Math.random() - 0.5) * 60, type: types[1 + Math.floor(Math.random() * 5)] });
            }
        } else if (Math.random() < 0.15) {
            this.items.push({ id: 'i_' + this.idCounter++, x, y, type: types[Math.floor(Math.random() * types.length)] });
        }
    }
    
    handleAttack(playerId, data) {
        const player = this.players.get(playerId);
        if (!player || !player.alive) return;
        const { targets } = data;
        if (!targets) return;
        
        targets.forEach(t => {
            let target = t.id === this.boss?.id ? this.boss : this.enemies.find(e => e.id === t.id);
            if (!target || target.hp <= 0) return;
            target.hp -= t.damage || 1;
            if (target.hp <= 0 && target !== this.boss) {
                player.score += target.score || 10;
                this.score += target.score || 10;
                this.killCount++;
                this.dropItem(target.x, target.y);
            }
        });
    }
    
    handleMissileExplosion(data) {
        const { x, y, radius } = data;
        this.enemyBullets = this.enemyBullets.filter(b => Math.hypot(b.x - x, b.y - y) > radius);
    }
    
    broadcast() {
        const state = {
            players: [],
            enemies: this.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp, size: e.size, color: e.color })),
            boss: this.boss ? { id: this.boss.id, x: this.boss.x, y: this.boss.y, hp: this.boss.hp, maxHp: this.boss.maxHp, size: this.boss.size, color: this.boss.color, name: this.boss.name } : null,
            bullets: this.enemyBullets.map(b => ({ x: b.x, y: b.y })),
            items: this.items,
            wave: this.wave,
            score: this.score
        };
        this.players.forEach(p => {
            state.players.push({
                id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle,
                hp: p.hp, maxHp: p.maxHp, alive: p.alive, dashing: p.dashing, invincible: p.invincible,
                weapons: p.weapons, autoFire: p.autoFire, fannels: p.fannels, score: p.score,
                respawnTimer: p.respawnTimer
            });
        });
        io.to(this.id).emit('state', state);
    }
    
    stop() { if (this.loopInterval) { clearInterval(this.loopInterval); this.loopInterval = null; } }
}

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    let currentRoom = null;
    
    socket.on('hostRoom', (data) => {
        const name = data.name || 'Host';
        const roomId = generateRoomCode();
        const room = new GameRoom(roomId);
        rooms.set(roomId, room);
        currentRoom = room;
        socket.join(roomId);
        const player = room.addPlayer(socket, name, true);
        socket.emit('hosted', { roomId, playerId: socket.id, player });
    });
    
    socket.on('joinRoom', (data) => {
        const roomId = data.roomId;
        const name = data.name || 'Player';
        if (!rooms.has(roomId)) { socket.emit('joinError', { message: 'Room not found' }); return; }
        const room = rooms.get(roomId);
        if (room.players.size >= 4) { socket.emit('joinError', { message: 'Room is full' }); return; }
        currentRoom = room;
        socket.join(roomId);
        const player = room.addPlayer(socket, name, false);
        socket.emit('joined', { roomId, playerId: socket.id, player, players: Array.from(room.players.values()) });
        socket.to(roomId).emit('playerJoined', { player });
    });
    
    socket.on('startGame', () => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (!player?.isHost) return;
        currentRoom.start();
        io.to(currentRoom.id).emit('gameStarted');
    });
    
    socket.on('input', (data) => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (!player) return;
        player.input = { dx: data.dx || 0, dy: data.dy || 0, dashing: data.dashing || false };
    });
    
    socket.on('toggleWeapon', (data) => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (!player) return;
        const w = data.weapon;
        if (player.autoFire.hasOwnProperty(w)) player.autoFire[w] = !player.autoFire[w];
    });
    
    socket.on('attack', (data) => { if (currentRoom) currentRoom.handleAttack(socket.id, data); });
    socket.on('missileExplosion', (data) => { if (currentRoom) currentRoom.handleMissileExplosion(data); });
    
    socket.on('disconnect', () => {
        if (currentRoom) {
            currentRoom.players.delete(socket.id);
            if (currentRoom.players.size === 0) { currentRoom.stop(); rooms.delete(currentRoom.id); }
            else io.to(currentRoom.id).emit('playerLeft', { playerId: socket.id });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('PLAZMERS Ver.1.004 Server on port ' + PORT));