const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ========== 定数 ==========
const WORLD_W = 3000, WORLD_H = 3000;
const FPS = 30;

// ========== ゲームデータ管理 ==========
const rooms = {}; 

const ENEMY_TYPES = {
    virus: { hp: 5, speed: 2, size: 10, color: '#0f0', score: 50 },
    bacteria: { hp: 8, speed: 1.5, size: 14, color: '#0a0', score: 60 },
    infected: { hp: 15, speed: 1.8, size: 18, color: '#ff0', score: 100 },
    mutant: { hp: 25, speed: 2.2, size: 16, color: '#f80', score: 150 },
    toxin: { hp: 12, speed: 2.5, size: 12, color: '#f0f', score: 120 },
    parasite: { hp: 35, speed: 1.2, size: 22, color: '#88f', score: 200 },
    cancer: { hp: 50, speed: 1, size: 30, color: '#800', score: 300 },
    tumor: { hp: 80, speed: 0.5, size: 40, color: '#400', score: 400 },
    plague: { hp: 60, speed: 2, size: 25, color: '#0ff', score: 350 },
    necrosis: { hp: 100, speed: 0.8, size: 35, color: '#444', score: 500 }
};

const BOSS_TYPES = [
    { name: 'VIRUS-α', color: '#0f0', baseHp: 450, size: 50, pattern: 'radial' },
    { name: 'BACTERIA-β', color: '#08f', baseHp: 675, size: 55, pattern: 'spiral' },
    { name: 'INFECTION-γ', color: '#f80', baseHp: 900, size: 60, pattern: 'burst' },
    { name: 'CANCER-δ', color: '#f00', baseHp: 1200, size: 70, pattern: 'divide' },
    { name: 'PLAGUE-ε', color: '#f0f', baseHp: 1500, size: 75, pattern: 'swarm' },
    { name: 'NECROSIS-ζ', color: '#888', baseHp: 1800, size: 80, pattern: 'laser' },
    { name: 'PANDEMIC-η', color: '#ff0', baseHp: 2250, size: 85, pattern: 'chaos' },
    { name: 'OMEGA-CELL', color: '#fff', baseHp: 3000, size: 100, pattern: 'all' }
];

const MEGA_BOSS_TYPES = [
    { name: 'APOCALYPSE-Ω', color: '#f00', baseHp: 7500, size: 120, pattern: 'mega1' },
    { name: 'EXTINCTION-Ψ', color: '#0ff', baseHp: 12000, size: 130, pattern: 'mega2' },
    { name: 'OBLIVION-Φ', color: '#ff0', baseHp: 18000, size: 140, pattern: 'mega3' },
    { name: 'GENESIS-∞', color: '#fff', baseHp: 30000, size: 150, pattern: 'final' }
];

const PLAYER_COLORS = ['#00f2ff', '#ff0055', '#00ff66', '#ffaa00'];

class Room {
    constructor(id, hostId, hostName) {
        this.id = id;
        this.hostId = hostId;
        this.players = [];
        this.enemies = [];
        this.items = [];
        this.walls = [];
        this.wave = 0;
        this.score = 0;
        this.state = 'waiting';
        this.enemyIdCounter = 0;
        this.waveTimer = 0;
        this.mobSpawnTimer = 0;
        this.addPlayer(hostId, hostName, true);
    }

    addPlayer(id, name, isHost = false) {
        const color = PLAYER_COLORS[this.players.length % PLAYER_COLORS.length];
        const player = {
            id: id, name: name, isHost: isHost, ready: isHost, color: color,
            x: WORLD_W/2 + (Math.random()-0.5)*100, y: WORLD_H/2 + (Math.random()-0.5)*100,
            angle: 0, hp: 100, maxHp: 100, score: 0, alive: true, respawnTimer: 0,
            invincible: 0, dashing: false,
            weaponLevels: { PLAZMER: 1, HOMING: 0, LASER: 0, THUNDER: 0, ALLRANGE: 0 },
            thunderEnergy: 0, options: []
        };
        this.players.push(player);
        return player;
    }

    removePlayer(id) {
        const index = this.players.findIndex(p => p.id === id);
        if (index !== -1) {
            const wasHost = this.players[index].isHost;
            this.players.splice(index, 1);
            return wasHost;
        }
        return false;
    }

    getPlayer(id) { return this.players.find(p => p.id === id); }

    startGame() {
        this.state = 'playing';
        this.wave = 0;
        this.score = 0;
        this.walls = generateMazeWalls(0);
        this.enemies = [];
        this.items = [];
        this.players.forEach(p => {
            p.hp = 100; p.alive = true;
            p.x = WORLD_W/2 + (Math.random()-0.5)*100; p.y = WORLD_H/2 + (Math.random()-0.5)*100;
            p.weaponLevels = { PLAZMER: 1, HOMING: 0, LASER: 0, THUNDER: 0, ALLRANGE: 0 };
            p.score = 0;
        });
        this.startWave();
    }

    startWave() {
        this.wave++;
        this.walls = generateMazeWalls(this.wave);
        this.waveTimer = 0;
        io.to(this.id).emit('waveStart', { wave: this.wave, walls: this.walls });
        
        let bossCount = 1;
        if (this.wave >= 50) bossCount = 3;
        else if (this.wave >= 20) bossCount = 2;
        if (this.wave % 10 === 0) bossCount += 1;

        setTimeout(() => {
            if (this.state === 'playing') {
                for (let i = 0; i < bossCount; i++) this.spawnBoss();
            }
        }, 3000);
    }

    spawnBoss() {
        let template, bossIndex;
        if (this.wave >= 100) {
            bossIndex = (Math.floor((this.wave - 100) / 10)) % MEGA_BOSS_TYPES.length;
            template = MEGA_BOSS_TYPES[bossIndex];
        } else {
            bossIndex = (this.wave - 1) % BOSS_TYPES.length;
            template = BOSS_TYPES[bossIndex];
        }

        let waveScale = 1 + Math.floor(this.wave / 5) * 1.0;
        if (this.wave > 20) waveScale *= (1 + (this.wave - 20) * 0.5);
        const hardHpMult = 1.5;
        const playerCountMult = 1 + (this.players.length - 1) * 0.5;

        const pos = findSafeSpawnPosition(this.walls, this.players);
        const boss = {
            id: 'boss_' + (this.enemyIdCounter++), type: 'boss',
            x: pos.x, y: pos.y,
            hp: Math.floor(template.baseHp * waveScale * hardHpMult * playerCountMult),
            maxHp: Math.floor(template.baseHp * waveScale * hardHpMult * playerCountMult),
            speed: 1.5, size: template.size + Math.floor(this.wave / 5) * 2,
            color: template.color, score: 3000 + this.wave * 500, name: template.name,
            isBoss: true, pattern: template.pattern, timer: 0, attackTimer: 0, phase: 0
        };
        this.enemies.push(boss);
        io.to(this.id).emit('bossSpawn', { boss: boss });
    }

    spawnMob() {
        const maxMobs = Math.min(150, 30 + this.wave * 2);
        if (this.enemies.filter(e => !e.isBoss).length >= maxMobs) return;

        const types = Object.keys(ENEMY_TYPES);
        let availableTypes = ['virus', 'bacteria'];
        if (this.wave >= 2) availableTypes.push('infected', 'toxin');
        if (this.wave >= 4) availableTypes.push('mutant', 'parasite');
        if (this.wave >= 6) availableTypes.push('cancer');
        if (this.wave >= 8) availableTypes.push('tumor', 'plague');
        if (this.wave >= 10) availableTypes.push('necrosis');

        const typeKey = availableTypes[Math.floor(Math.random() * availableTypes.length)];
        const template = ENEMY_TYPES[typeKey];
        
        let waveScale = 1 + this.wave * 0.1;
        let speedMult = 1;
        if (this.wave > 20) {
            waveScale *= (1 + Math.pow((this.wave - 20) * 0.1, 2));
            speedMult = 1.3 + Math.min(0.5, (this.wave - 20) * 0.02);
        }

        const pos = findSafeSpawnPosition(this.walls, this.players, 200);
        this.enemies.push({
            id: 'e_' + (this.enemyIdCounter++), type: typeKey, x: pos.x, y: pos.y,
            hp: Math.floor(template.hp * waveScale), maxHp: Math.floor(template.hp * waveScale),
            speed: Math.min(template.speed * 2.5 * speedMult, (template.speed + this.wave * 0.05) * speedMult),
            size: template.size, color: template.color, score: template.score,
            isBoss: false, timer: Math.floor(Math.random() * 60), phase: Math.random() * Math.PI * 2
        });
    }

    update() {
        if (this.state !== 'playing') return;
        this.waveTimer++; this.mobSpawnTimer++;

        // プレイヤー状態更新
        this.players.forEach(p => {
            if (!p.alive) {
                p.respawnTimer--;
                if (p.respawnTimer <= 0) {
                    p.alive = true; p.hp = p.maxHp; p.x = WORLD_W/2; p.y = WORLD_H/2; p.invincible = 120;
                    io.to(this.id).emit('playerRespawned', { playerId: p.id, name: p.name, x: p.x, y: p.y, hp: p.hp });
                    io.to(p.id).emit('respawned', { x: p.x, y: p.y, hp: p.hp });
                }
            } else {
                if (p.invincible > 0) p.invincible--;
                p.x = Math.max(60, Math.min(WORLD_W - 60, p.x));
                p.y = Math.max(60, Math.min(WORLD_H - 60, p.y));
                if (p.weaponLevels.THUNDER > 0 && p.thunderEnergy < 180) p.thunderEnergy += 0.5;
            }
        });

        // 敵生成
        const activeBosses = this.enemies.filter(e => e.isBoss && e.hp > 0);
        if (activeBosses.length > 0 && this.mobSpawnTimer >= 60) {
            this.mobSpawnTimer = 0;
            const batchSize = 1 + Math.floor(this.wave / 10);
            for(let i=0; i<batchSize; i++) this.spawnMob();
        }

        // 敵の更新と当たり判定
        this.enemies.forEach(e => {
            if (e.hp <= 0) return;
            e.timer++;
            if (checkWall(e.x, e.y, this.walls)) escapeFromWall(e, this.walls);

            let target = null, minDist = 99999;
            this.players.forEach(p => {
                if (p.alive) {
                    const dist = Math.hypot(p.x - e.x, p.y - e.y);
                    if (dist < minDist) { minDist = dist; target = p; }
                }
            });

            if (target) {
                const angle = Math.atan2(target.y - e.y, target.x - e.x);
                const vx = Math.cos(angle) * e.speed;
                const vy = Math.sin(angle) * e.speed;
                if (!checkWall(e.x + vx, e.y + vy, this.walls)) { e.x += vx; e.y += vy; }
                
                if (minDist < e.size + 10 && target.invincible <= 0 && !target.dashing) {
                    const dmg = e.isBoss ? 20 : 10;
                    target.hp -= dmg; target.invincible = 30;
                    io.to(this.id).emit('playerDamaged', { playerId: target.id, damage: dmg, hp: target.hp });
                    if (target.hp <= 0) {
                        target.alive = false; target.respawnTimer = 180;
                        io.to(this.id).emit('playerDied', { playerId: target.id, name: target.name });
                        if (this.players.every(p => !p.alive)) {
                            this.state = 'gameover';
                            io.to(this.id).emit('gameOver', { score: this.score, wave: this.wave });
                        }
                    }
                }
            }
            // ボス攻撃はクライアント側で演出同期（簡易化）
            if (e.isBoss) { e.attackTimer++; }
        });

        // 死亡した敵の削除
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            if (this.enemies[i].hp <= 0) this.enemies.splice(i, 1);
        }

        // WAVEクリア判定
        if (activeBosses.length === 0 && this.enemies.filter(e => e.isBoss).length === 0 && this.wave > 0) {
             this.enemies.forEach(e => { if (!e.isBoss) { e.hp = 0; this.score += 50; } });
             this.enemies = [];
             io.to(this.id).emit('bossDefeated', { wave: this.wave });
             setTimeout(() => { if (this.state === 'playing') this.startWave(); }, 3000);
        }
    }
}

// ユーティリティ
function generateMazeWalls(waveNum) {
    const w = [];
    const thickness = 50;
    w.push({ x: 0, y: 0, w: WORLD_W, h: thickness, type: 'border' });
    w.push({ x: 0, y: WORLD_H - thickness, w: WORLD_W, h: thickness, type: 'border' });
    w.push({ x: 0, y: 0, w: thickness, h: WORLD_H, type: 'border' });
    w.push({ x: WORLD_W - thickness, y: 0, w: thickness, h: WORLD_H, type: 'border' });
    const gridSize = 300;
    for (let gx = 1; gx < Math.floor(WORLD_W/gridSize); gx++) {
        for (let gy = 1; gy < Math.floor(WORLD_H/gridSize); gy++) {
            if (Math.random() < 0.4 + waveNum * 0.02) {
                const cx = gx * gridSize + gridSize/2; const cy = gy * gridSize + gridSize/2;
                w.push({ x: cx - 40, y: cy - 40, w: 80, h: 80, type: 'cell', cx: cx, cy: cy, radius: 40 });
            }
        }
    }
    return w;
}
function checkWall(x, y, walls) {
    for (const w of walls) {
        if (w.type === 'cell') { if (Math.hypot(x - w.cx, y - w.cy) < w.radius) return true; }
        else { if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true; }
    }
    return false;
}
function escapeFromWall(entity, walls) {
    for (let dist = 10; dist < 500; dist += 10) {
        for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
            const tx = entity.x + Math.cos(a) * dist; const ty = entity.y + Math.sin(a) * dist;
            if (!checkWall(tx, ty, walls) && tx > 50 && tx < WORLD_W - 50 && ty > 50 && ty < WORLD_H - 50) {
                entity.x = tx; entity.y = ty; return;
            }
        }
    }
}
function findSafeSpawnPosition(walls, players, minDist = 400) {
    for (let i = 0; i < 50; i++) {
        const x = 150 + Math.random() * (WORLD_W - 300);
        const y = 150 + Math.random() * (WORLD_H - 300);
        if (checkWall(x, y, walls)) continue;
        let tooClose = false;
        for (const p of players) { if (Math.hypot(p.x - x, p.y - y) < minDist) { tooClose = true; break; } }
        if (!tooClose) return { x, y };
    }
    return { x: WORLD_W - 100, y: WORLD_H - 100 };
}
function generateRoomId() { return Math.floor(1000 + Math.random() * 9000).toString(); }

// ========== Socket.IO ==========
io.on('connection', (socket) => {
    // 部屋作成
    socket.on('hostRoom', (data) => {
        const roomId = generateRoomId();
        rooms[roomId] = new Room(roomId, socket.id, data.name);
        socket.join(roomId);
        socket.emit('hosted', {
            roomId: roomId, playerId: socket.id,
            player: rooms[roomId].getPlayer(socket.id),
            players: rooms[roomId].players, walls: rooms[roomId].walls
        });
    });

    // 部屋参加
    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomId];
        if (!room) { socket.emit('joinError', { message: 'Room not found' }); return; }
        if (room.state !== 'waiting' && room.players.length >= 4) { socket.emit('joinError', { message: 'Room full or playing' }); return; }
        
        socket.join(data.roomId);
        const player = room.addPlayer(socket.id, data.name);
        socket.emit('joined', {
            roomId: data.roomId, playerId: socket.id, player: player,
            players: room.players, walls: room.walls, isGuest: true, state: room.state
        });
        socket.to(data.roomId).emit('playerJoined', { player: player, players: room.players });
    });

    // 準備完了
    socket.on('playerReady', () => {
        for (const rid in rooms) {
            const player = rooms[rid].getPlayer(socket.id);
            if (player) {
                player.ready = true;
                io.to(rid).emit('playerReadyUpdate', { players: rooms[rid].players });
                break;
            }
        }
    });

    // ゲーム開始
    socket.on('startGame', () => {
        for (const rid in rooms) {
            if (rooms[rid].hostId === socket.id) {
                rooms[rid].startGame();
                io.to(rid).emit('gameStarted', { players: rooms[rid].players });
                io.to(rid).emit('gameStart');
                break;
            }
        }
    });

    // 入力受信
    socket.on('input', (data) => {
        for (const rid in rooms) {
            const p = rooms[rid].getPlayer(socket.id);
            if (p && p.alive) {
                p.x = data.x; p.y = data.y; p.angle = data.angle; p.dashing = data.dash;
            }
        }
    });

    // 発射イベント (他プレイヤーへの同期用)
    socket.on('fire', (data) => {
        for (const rid in rooms) {
            if(rooms[rid].getPlayer(socket.id)) {
                socket.to(rid).emit('remoteFire', { playerId: socket.id, type: data.type, angle: data.angle, options: data.options });
                break;
            }
        }
    });

    // ヒット通知 (クライアントからのダメージ報告)
    socket.on('hit', (data) => {
        for (const rid in rooms) {
            const room = rooms[rid];
            const p = room.getPlayer(socket.id);
            if (p && p.alive) {
                const enemy = room.enemies.find(e => e.id === data.enemyId);
                if (enemy) {
                    enemy.hp -= data.damage;
                    // スコア加算
                    p.score += Math.floor(data.damage / 2);
                    
                    if (enemy.hp <= 0) {
                        p.score += enemy.score;
                        // アイテムドロップ判定
                        const dropChance = enemy.isBoss ? 1.0 : 0.1;
                        if (Math.random() < dropChance) {
                            const types = ['PLAZMER', 'HOMING', 'LASER', 'THUNDER', 'ALLRANGE', 'H'];
                            const itemType = types[Math.floor(Math.random() * types.length)];
                            if (itemType === 'H') p.hp = Math.min(p.maxHp, p.hp + 30);
                            else if (itemType === 'ALLRANGE') { if(p.options.length < 6) p.options.push({}); p.weaponLevels.ALLRANGE++; }
                            else p.weaponLevels[itemType]++;
                            
                            io.to(rid).emit('itemCollected', { playerId: p.id, weaponLevels: p.weaponLevels, hp: p.hp, options: p.options.length });
                        }
                        io.to(rid).emit('enemyDefeated', { isBoss: enemy.isBoss, enemyId: enemy.id });
                    }
                }
            }
        }
    });

    // 切断
    socket.on('disconnect', () => {
        for (const rid in rooms) {
            const wasHost = rooms[rid].removePlayer(socket.id);
            if (rooms[rid].players.length === 0) delete rooms[rid];
            else {
                io.to(rid).emit('playerLeft', { playerId: socket.id });
                if (wasHost) { delete rooms[rid]; io.to(rid).emit('hostCancelled'); }
                else io.to(rid).emit('playerReadyUpdate', { players: rooms[rid].players });
            }
        }
    });
});

// ========== サーバー推論ループ ==========
setInterval(() => {
    for (const rid in rooms) {
        const room = rooms[rid];
        if (room.state === 'playing') {
            room.update();
            io.to(rid).emit('gameState', {
                players: room.players.map(p => ({
                    id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y),
                    angle: p.angle, hp: p.hp, maxHp: p.maxHp, alive: p.alive,
                    color: p.color, dashing: p.dashing, score: p.score,
                    invincible: p.invincible, thunderEnergy: p.thunderEnergy,
                    respawnTimer: p.respawnTimer
                })),
                enemies: room.enemies.map(e => ({
                    id: e.id, x: Math.round(e.x), y: Math.round(e.y),
                    type: e.type, hp: e.hp, maxHp: e.maxHp, size: e.size, color: e.color, isBoss: e.isBoss
                })),
                wave: room.wave, score: room.score
            });
        }
    }
}, 1000 / FPS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PLAZMERS Server running on port ${PORT}`));
