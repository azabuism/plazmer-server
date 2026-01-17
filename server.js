const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ['websocket', 'polling'], pingTimeout: 60000, pingInterval: 25000 });

app.use(express.static('public'));

const WORLD_W = 3000, WORLD_H = 3000, TICK_RATE = 60;
const MAX_ENEMIES = 80, MAX_ENEMY_BULLETS = 200, MAX_ITEMS = 50, RESPAWN_TIME = 300, WALL_THICKNESS = 40;

function generateMaze() {
    const walls = [];
    walls.push({ x: 0, y: 0, w: WORLD_W, h: WALL_THICKNESS });
    walls.push({ x: 0, y: WORLD_H - WALL_THICKNESS, w: WORLD_W, h: WALL_THICKNESS });
    walls.push({ x: 0, y: 0, w: WALL_THICKNESS, h: WORLD_H });
    walls.push({ x: WORLD_W - WALL_THICKNESS, y: 0, w: WALL_THICKNESS, h: WORLD_H });
    const patterns = [
        { x: 600, y: 600, w: 400, h: 40 }, { x: 600, y: 600, w: 40, h: 300 },
        { x: 2000, y: 600, w: 400, h: 40 }, { x: 2360, y: 600, w: 40, h: 300 },
        { x: 200, y: 300, w: 300, h: 40 }, { x: 200, y: 300, w: 40, h: 400 },
        { x: 2500, y: 300, w: 300, h: 40 }, { x: 2760, y: 300, w: 40, h: 400 },
        { x: 200, y: 2300, w: 300, h: 40 }, { x: 200, y: 2300, w: 40, h: 400 },
        { x: 2500, y: 2300, w: 300, h: 40 }, { x: 2760, y: 2300, w: 40, h: 400 },
        { x: 1400, y: 1200, w: 200, h: 40 }, { x: 1400, y: 1760, w: 200, h: 40 },
        { x: 1200, y: 1400, w: 40, h: 200 }, { x: 1760, y: 1400, w: 40, h: 200 },
        { x: 800, y: 1000, w: 40, h: 400 }, { x: 2160, y: 1000, w: 40, h: 400 },
        { x: 800, y: 1600, w: 40, h: 400 }, { x: 2160, y: 1600, w: 40, h: 400 },
        { x: 500, y: 1500, w: 150, h: 40 }, { x: 2350, y: 1500, w: 150, h: 40 },
        { x: 1000, y: 200, w: 40, h: 300 }, { x: 1960, y: 200, w: 40, h: 300 },
        { x: 1000, y: 2500, w: 40, h: 300 }, { x: 1960, y: 2500, w: 40, h: 300 },
    ];
    walls.push(...patterns);
    return walls;
}

const MAZE_WALLS = generateMaze();

const ENEMY_TYPES = {
    small: { hp: 5, speed: 2.5, size: 12, color: '#0f0', score: 10 },
    medium: { hp: 15, speed: 2, size: 18, color: '#ff0', score: 30 },
    large: { hp: 35, speed: 1.5, size: 26, color: '#f80', score: 50 },
    tank: { hp: 60, speed: 1, size: 34, color: '#f00', score: 100 },
    elite: { hp: 100, speed: 2.2, size: 30, color: '#f0f', score: 200 }
};

const BOSS_TYPES = [
    { name: 'GUARDIAN-α', hp: 250, size: 55, color: '#0ff', speed: 1.8 },
    { name: 'SENTINEL-β', hp: 500, size: 65, color: '#f0f', speed: 2.0 },
    { name: 'DESTROYER-γ', hp: 800, size: 75, color: '#ff0', speed: 2.2 },
    { name: 'OVERLORD-δ', hp: 1200, size: 85, color: '#f00', speed: 2.4 },
    { name: 'NEMESIS-Ω', hp: 2000, size: 100, color: '#fff', speed: 2.8 }
];

const rooms = new Map();

class GameRoom {
    constructor(id) {
        this.id = id; this.players = new Map(); this.enemies = []; this.enemyBullets = [];
        this.items = []; this.wave = 0; this.score = 0; this.state = 'waiting';
        this.frame = 0; this.idCounter = 0; this.boss = null; this.killCount = 0; this.walls = MAZE_WALLS;
    }

    addPlayer(socket, name, isHost = false) {
        let spawnX, spawnY;
        for (let i = 0; i < 50; i++) {
            spawnX = WORLD_W / 2 + (Math.random() - 0.5) * 400;
            spawnY = WORLD_H / 2 + (Math.random() - 0.5) * 400;
            if (!this.checkWallCollision(spawnX, spawnY, 20)) break;
        }
        const player = {
            id: socket.id, name, x: spawnX, y: spawnY, angle: -Math.PI / 2,
            hp: 100, maxHp: 100, alive: true, score: 0, isHost,
            invincible: 180, dashing: false, respawnTimer: 0,
            weapons: { gatling: 1, phalanx: 0, missile: 0, laser: 0, dash: 1 },
            autoFire: { gatling: false, phalanx: false, missile: false, laser: false },
            phalanxUnits: [], input: { dx: 0, dy: 0, dashing: false }
        };
        this.players.set(socket.id, player);
        return player;
    }

    checkWallCollision(x, y, r) {
        for (const w of this.walls) {
            const cx = Math.max(w.x, Math.min(x, w.x + w.w));
            const cy = Math.max(w.y, Math.min(y, w.y + w.h));
            if ((x - cx) ** 2 + (y - cy) ** 2 < r ** 2) return true;
        }
        return false;
    }

    resolveWallCollision(x, y, r) {
        let nx = x, ny = y;
        for (const w of this.walls) {
            const cx = Math.max(w.x, Math.min(nx, w.x + w.w));
            const cy = Math.max(w.y, Math.min(ny, w.y + w.h));
            const dx = nx - cx, dy = ny - cy, d = Math.sqrt(dx * dx + dy * dy);
            if (d < r && d > 0) { nx += (dx / d) * (r - d) * 1.1; ny += (dy / d) * (r - d) * 1.1; }
        }
        return { x: nx, y: ny };
    }

    start() {
        this.state = 'playing'; this.wave = 0; this.score = 0; this.killCount = 0;
        this.enemies = []; this.enemyBullets = []; this.items = []; this.boss = null;
        this.startWave();
        if (!this.loopInterval) this.loopInterval = setInterval(() => this.update(), 1000 / TICK_RATE);
    }

    startWave() {
        this.wave++; this.killCount = 0; this.boss = null;
        if (this.wave % 5 === 0) {
            const idx = Math.min(Math.floor(this.wave / 5) - 1, BOSS_TYPES.length - 1);
            const t = BOSS_TYPES[idx];
            this.boss = { id: 'boss_' + this.idCounter++, x: WORLD_W / 2, y: 400, hp: t.hp, maxHp: t.hp, size: t.size, color: t.color, speed: t.speed, name: t.name, timer: 0 };
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
                const dashLv = p.weapons.dash || 1;
                const speed = p.input.dashing ? 5 + dashLv * 0.8 : 5;
                let nx = p.x + p.input.dx * speed, ny = p.y + p.input.dy * speed;
                const res = this.resolveWallCollision(nx, ny, 15);
                p.x = Math.max(50, Math.min(WORLD_W - 50, res.x));
                p.y = Math.max(50, Math.min(WORLD_H - 50, res.y));
                p.dashing = p.input.dashing;
                if (p.input.dx !== 0 || p.input.dy !== 0) p.angle = Math.atan2(p.input.dy, p.input.dx);
                this.updatePhalanx(p);
            } else {
                p.respawnTimer++;
                if (p.respawnTimer >= RESPAWN_TIME) this.respawnPlayer(p);
            }
        });

        if (!this.boss && this.frame % 30 === 0) this.spawnEnemy();
        this.updateEnemies();
        if (this.boss) this.updateBoss();
        this.updateBullets();
        this.updateItems();

        if (!this.boss && this.killCount >= 20 + this.wave * 5) this.startWave();
        if (this.frame % 2 === 0) this.broadcast();
    }

    respawnPlayer(p) {
        let sx, sy;
        for (let i = 0; i < 50; i++) {
            sx = WORLD_W / 2 + (Math.random() - 0.5) * 400;
            sy = WORLD_H / 2 + (Math.random() - 0.5) * 400;
            if (!this.checkWallCollision(sx, sy, 20)) break;
        }
        p.alive = true; p.hp = p.maxHp; p.x = sx; p.y = sy;
        p.invincible = 180; p.respawnTimer = 0;
        io.to(p.id).emit('respawned');
    }

    updatePhalanx(p) {
        const lv = p.weapons.phalanx;
        if (lv <= 0) { p.phalanxUnits = []; return; }
        while (p.phalanxUnits.length < lv) p.phalanxUnits.push({ angle: Math.random() * Math.PI * 2, dist: 50 + Math.random() * 30 });
        while (p.phalanxUnits.length > lv) p.phalanxUnits.pop();
        p.phalanxUnits.forEach(f => f.angle += 0.04);

        if (p.autoFire.phalanx && this.frame % 12 === 0) {
            p.phalanxUnits.forEach(f => {
                const fx = p.x + Math.cos(f.angle) * f.dist, fy = p.y + Math.sin(f.angle) * f.dist;
                let target = null, minD = 350;
                this.enemies.forEach(e => { const d = Math.hypot(e.x - fx, e.y - fy); if (d < minD) { minD = d; target = e; } });
                if (this.boss) { const d = Math.hypot(this.boss.x - fx, this.boss.y - fy); if (d < minD) target = this.boss; }
                if (target) { target.hp -= 3 + lv; io.to(this.id).emit('phalanxShot', { x: fx, y: fy, tx: target.x, ty: target.y }); }
            });
        }
    }

    spawnEnemy() {
        if (this.enemies.length >= MAX_ENEMIES) return;
        const types = Object.keys(ENEMY_TYPES), weights = [40, 30, 15, 10, 5];
        let roll = Math.random() * 100, idx = 0;
        for (let i = 0; i < weights.length; i++) { roll -= weights[i]; if (roll <= 0) { idx = i; break; } }
        const t = ENEMY_TYPES[types[idx]];
        let ex, ey;
        for (let i = 0; i < 50; i++) {
            const side = Math.floor(Math.random() * 4);
            if (side === 0) { ex = Math.random() * WORLD_W; ey = 100; }
            else if (side === 1) { ex = Math.random() * WORLD_W; ey = WORLD_H - 100; }
            else if (side === 2) { ex = 100; ey = Math.random() * WORLD_H; }
            else { ex = WORLD_W - 100; ey = Math.random() * WORLD_H; }
            if (!this.checkWallCollision(ex, ey, t.size)) break;
        }
        this.enemies.push({ id: 'e_' + this.idCounter++, x: ex, y: ey, hp: t.hp, maxHp: t.hp, speed: t.speed, size: t.size, color: t.color, score: t.score, shootTimer: Math.random() * 60 });
    }

    updateEnemies() {
        this.enemies = this.enemies.filter(e => {
            if (e.hp <= 0) return false;
            let tx = WORLD_W / 2, ty = WORLD_H / 2, minD = Infinity;
            this.players.forEach(p => { if (p.alive) { const d = Math.hypot(p.x - e.x, p.y - e.y); if (d < minD) { minD = d; tx = p.x; ty = p.y; } } });
            const a = Math.atan2(ty - e.y, tx - e.x);
            const res = this.resolveWallCollision(e.x + Math.cos(a) * e.speed, e.y + Math.sin(a) * e.speed, e.size);
            e.x = res.x; e.y = res.y;
            e.shootTimer--;
            if (e.shootTimer <= 0 && this.enemyBullets.length < MAX_ENEMY_BULLETS && minD < 400) {
                this.enemyBullets.push({ x: e.x, y: e.y, vx: Math.cos(a) * 4, vy: Math.sin(a) * 4, life: 150 });
                e.shootTimer = 90 + Math.random() * 60;
            }
            this.players.forEach(p => {
                if (!p.alive || p.invincible > 0) return;
                if (Math.hypot(p.x - e.x, p.y - e.y) < 15 + e.size) {
                    p.hp -= 15; p.invincible = 60;
                    if (p.hp <= 0) { p.alive = false; p.respawnTimer = 0; io.to(p.id).emit('died'); }
                }
            });
            return true;
        });
    }

    updateBoss() {
        if (!this.boss) return;
        if (this.boss.hp <= 0) {
            this.score += 500 * Math.floor(this.wave / 5);
            for (let i = 0; i < 5; i++) this.dropItem(this.boss.x + (Math.random() - 0.5) * 100, this.boss.y + (Math.random() - 0.5) * 100, true);
            io.to(this.id).emit('bossDefeated', { wave: this.wave });
            this.boss = null;
            setTimeout(() => { if (this.state === 'playing') this.startWave(); }, 2000);
            return;
        }
        this.boss.timer++;
        let tx = WORLD_W / 2, ty = WORLD_H / 2;
        this.players.forEach(p => { if (p.alive) { tx = p.x; ty = p.y; } });
        const a = Math.atan2(ty - this.boss.y, tx - this.boss.x);
        const res = this.resolveWallCollision(this.boss.x + Math.cos(a) * this.boss.speed * 0.6, this.boss.y + Math.sin(a) * this.boss.speed * 0.6, this.boss.size);
        this.boss.x = Math.max(150, Math.min(WORLD_W - 150, res.x));
        this.boss.y = Math.max(150, Math.min(WORLD_H - 150, res.y));
        const fireRate = Math.max(30, 60 - this.wave * 2);
        if (this.boss.timer % fireRate === 0 && this.enemyBullets.length < MAX_ENEMY_BULLETS) {
            const cnt = 8 + Math.floor(this.wave / 2);
            for (let i = 0; i < cnt; i++) {
                const ba = (Math.PI * 2 / cnt) * i + this.boss.timer * 0.03;
                this.enemyBullets.push({ x: this.boss.x, y: this.boss.y, vx: Math.cos(ba) * 3.5, vy: Math.sin(ba) * 3.5, life: 200, boss: true });
            }
        }
        this.players.forEach(p => {
            if (!p.alive || p.invincible > 0) return;
            if (Math.hypot(p.x - this.boss.x, p.y - this.boss.y) < 20 + this.boss.size) {
                p.hp -= 25; p.invincible = 90;
                if (p.hp <= 0) { p.alive = false; p.respawnTimer = 0; io.to(p.id).emit('died'); }
            }
        });
    }

    updateBullets() {
        this.enemyBullets = this.enemyBullets.filter(b => {
            b.x += b.vx; b.y += b.vy; b.life--;
            if (b.life <= 0 || this.checkWallCollision(b.x, b.y, 3)) return false;
            let hit = false;
            this.players.forEach(p => {
                if (!p.alive || p.invincible > 0) return;
                if (Math.hypot(p.x - b.x, p.y - b.y) < 14) {
                    p.hp -= b.boss ? 12 : 8; p.invincible = 30; hit = true;
                    if (p.hp <= 0) { p.alive = false; p.respawnTimer = 0; io.to(p.id).emit('died'); }
                }
            });
            return !hit;
        });
    }

    updateItems() {
        this.items = this.items.filter(item => {
            let col = false;
            this.players.forEach(p => { if (p.alive && Math.hypot(p.x - item.x, p.y - item.y) < 35) { col = true; this.collectItem(p, item); } });
            return !col;
        });
    }

    collectItem(p, item) {
        switch (item.type) {
            case 'HP': p.hp = Math.min(p.maxHp, p.hp + 30); break;
            case 'GATLING': p.weapons.gatling = Math.min(10, p.weapons.gatling + 1); break;
            case 'PHALANX': p.weapons.phalanx = Math.min(10, p.weapons.phalanx + 1); break;
            case 'MISSILE': p.weapons.missile = Math.min(10, p.weapons.missile + 1); break;
            case 'LASER': p.weapons.laser = Math.min(10, p.weapons.laser + 1); break;
            case 'DASH': p.weapons.dash = Math.min(10, p.weapons.dash + 1); break;
        }
        io.to(p.id).emit('itemCollected', { type: item.type });
    }

    dropItem(x, y, isBoss = false) {
        if (this.items.length >= MAX_ITEMS) return;
        const types = ['HP', 'GATLING', 'PHALANX', 'MISSILE', 'LASER', 'DASH'];
        if (isBoss) this.items.push({ id: 'i_' + this.idCounter++, x, y, type: types[1 + Math.floor(Math.random() * 5)] });
        else if (Math.random() < 0.2) this.items.push({ id: 'i_' + this.idCounter++, x, y, type: types[Math.floor(Math.random() * types.length)] });
    }

    handleAttack(playerId, data) {
        const p = this.players.get(playerId);
        if (!p || !p.alive || !data.targets) return;
        data.targets.forEach(t => {
            let target = t.id === this.boss?.id ? this.boss : this.enemies.find(e => e.id === t.id);
            if (!target || target.hp <= 0) return;
            target.hp -= t.damage || 1;
            if (target.hp <= 0 && target !== this.boss) { p.score += target.score || 10; this.score += target.score || 10; this.killCount++; this.dropItem(target.x, target.y); }
        });
    }

    handleMissileExplosion(data) { this.enemyBullets = this.enemyBullets.filter(b => Math.hypot(b.x - data.x, b.y - data.y) > data.radius); }

    broadcast() {
        const state = {
            players: [], enemies: this.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp, size: e.size, color: e.color })),
            boss: this.boss ? { id: this.boss.id, x: this.boss.x, y: this.boss.y, hp: this.boss.hp, maxHp: this.boss.maxHp, size: this.boss.size, color: this.boss.color, name: this.boss.name } : null,
            bullets: this.enemyBullets.map(b => ({ x: b.x, y: b.y, boss: b.boss })), items: this.items, wave: this.wave, score: this.score, walls: this.walls
        };
        this.players.forEach(p => {
            state.players.push({ id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle, hp: p.hp, maxHp: p.maxHp, alive: p.alive, dashing: p.dashing, invincible: p.invincible, weapons: p.weapons, autoFire: p.autoFire, phalanxUnits: p.phalanxUnits, score: p.score, respawnTimer: p.respawnTimer });
        });
        io.to(this.id).emit('state', state);
    }

    stop() { if (this.loopInterval) { clearInterval(this.loopInterval); this.loopInterval = null; } }
}

function generateRoomCode() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code = ''; for (let i = 0; i < 4; i++) code += c[Math.floor(Math.random() * c.length)]; return code; }

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    let currentRoom = null;

    socket.on('hostRoom', (data) => {
        const name = data.name || 'Host', roomId = generateRoomCode();
        const room = new GameRoom(roomId); rooms.set(roomId, room); currentRoom = room;
        socket.join(roomId);
        const player = room.addPlayer(socket, name, true);
        socket.emit('hosted', { roomId, playerId: socket.id, player, walls: room.walls, worldW: WORLD_W, worldH: WORLD_H });
    });

    socket.on('joinRoom', (data) => {
        const roomId = data.roomId, name = data.name || 'Player';
        if (!rooms.has(roomId)) { socket.emit('joinError', { message: 'Room not found' }); return; }
        const room = rooms.get(roomId);
        if (room.players.size >= 4) { socket.emit('joinError', { message: 'Room is full' }); return; }
        currentRoom = room; socket.join(roomId);
        const player = room.addPlayer(socket, name, false);
        socket.emit('joined', { roomId, playerId: socket.id, player, players: Array.from(room.players.values()), walls: room.walls, worldW: WORLD_W, worldH: WORLD_H });
        socket.to(roomId).emit('playerJoined', { player });
    });

    socket.on('startGame', () => { if (!currentRoom) return; const p = currentRoom.players.get(socket.id); if (!p?.isHost) return; currentRoom.start(); io.to(currentRoom.id).emit('gameStarted'); });
    socket.on('input', (data) => { if (!currentRoom) return; const p = currentRoom.players.get(socket.id); if (p) p.input = { dx: data.dx || 0, dy: data.dy || 0, dashing: data.dashing || false }; });
    socket.on('toggleWeapon', (data) => { if (!currentRoom) return; const p = currentRoom.players.get(socket.id); if (p && p.autoFire.hasOwnProperty(data.weapon)) p.autoFire[data.weapon] = !p.autoFire[data.weapon]; });
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
server.listen(PORT, () => console.log('PLAZMERS Ver.1.006 Server on port ' + PORT));