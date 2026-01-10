const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static('public'));

// ========== 定数 ==========
const WORLD_W = 3000, WORLD_H = 3000;
const TICK_RATE = 60;
const TICK_INTERVAL = 1000 / TICK_RATE;
const MAX_ENEMY_BULLETS = 500; // 敵弾上限

// 武器レベルのデフォルト値（クライアントと同期）
const DEFAULT_WEAPON_LEVELS = {
    PLAZMER: 1, HOMING: 0, LASER: 0, THUNDER: 0,
    PHALANX: 1, INTERCEPT: 0, REFLECT: 0, RIFT: 0,
    ANCHOR: 0, DASH: 1, PIERCE: 0, OVERLOAD: 0
};

// ========== 敵テンプレート ==========
const ENEMY_TYPES = {
    virus: { hp: 3, speed: 1.8, size: 10, color: '#0f0', score: 50 },
    bacteria: { hp: 5, speed: 1.3, size: 14, color: '#0a0', score: 60 },
    infected: { hp: 10, speed: 1.5, size: 18, color: '#ff0', score: 100, shoots: true },
    mutant: { hp: 18, speed: 2, size: 16, color: '#f80', score: 150 },
    toxin: { hp: 8, speed: 2.2, size: 12, color: '#f0f', score: 120 },
    parasite: { hp: 25, speed: 1, size: 22, color: '#88f', score: 200, armor: true },
    cancer: { hp: 35, speed: 0.8, size: 30, color: '#800', score: 300, divides: true },
    tumor: { hp: 60, speed: 0.4, size: 40, color: '#400', score: 400 },
    plague: { hp: 45, speed: 1.8, size: 25, color: '#0ff', score: 350, shoots: true },
    necrosis: { hp: 80, speed: 0.6, size: 35, color: '#444', score: 500, armor: true }
};

const BOSS_TYPES = [
    { name: 'VIRUS-α', color: '#0f0', baseHp: 100, size: 50, pattern: 'radial', speed: 1.5 },
    { name: 'BACTERIA-β', color: '#08f', baseHp: 200, size: 55, pattern: 'spiral', speed: 2 },
    { name: 'INFECTION-γ', color: '#f80', baseHp: 350, size: 60, pattern: 'burst', speed: 2.5 },
    { name: 'CANCER-δ', color: '#f00', baseHp: 500, size: 70, pattern: 'divide', speed: 2 },
    { name: 'PLAGUE-ε', color: '#f0f', baseHp: 700, size: 75, pattern: 'swarm', speed: 3 },
    { name: 'NECROSIS-ζ', color: '#888', baseHp: 1000, size: 80, pattern: 'laser', speed: 2 },
    { name: 'PANDEMIC-η', color: '#ff0', baseHp: 1400, size: 85, pattern: 'chaos', speed: 3.5 },
    { name: 'NIGHTMARE-θ', color: '#f44', baseHp: 1800, size: 90, pattern: 'nightmare', speed: 3 },
    { name: 'APOCALYPSE-ι', color: '#a0f', baseHp: 2200, size: 95, pattern: 'apocalypse', speed: 3 },
    { name: 'OMEGA-CELL', color: '#fff', baseHp: 3000, size: 120, pattern: 'all', speed: 3.5 }
];

// ========== ルーム管理 ==========
const rooms = new Map();

class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = new Map();
        this.enemies = [];
        this.enemyBullets = [];
        this.items = [];
        this.walls = [];
        this.wave = 0;
        this.score = 0;
        this.state = 'waiting';
        this.frame = 0;
        this.enemyIdCounter = 0;
        this.waveTimer = 0;
        this.mobTimer = 0;
        this.currentBosses = [];
        
        this.generateWalls(0);
    }
    
    // ... generateWalls, checkWall, getWallNormal, escapeFromWall, addPlayer ...
    // (これらは変更がないため、スペース節約のため省略していませんが、以前のコードと同じです)
    generateWalls(waveNum) {
        this.walls = [];
        const thickness = 50;
        this.walls.push({ x: 0, y: 0, w: WORLD_W, h: thickness, type: 'border' });
        this.walls.push({ x: 0, y: WORLD_H - thickness, w: WORLD_W, h: thickness, type: 'border' });
        this.walls.push({ x: 0, y: 0, w: thickness, h: WORLD_H, type: 'border' });
        this.walls.push({ x: WORLD_W - thickness, y: 0, w: thickness, h: WORLD_H, type: 'border' });
        const gridSize = 300;
        const cellsX = Math.floor(WORLD_W / gridSize);
        const cellsY = Math.floor(WORLD_H / gridSize);
        for (let gx = 1; gx < cellsX - 1; gx++) {
            for (let gy = 1; gy < cellsY - 1; gy++) {
                if (gx >= cellsX/2 - 1 && gx <= cellsX/2 + 1 && gy >= cellsY/2 - 1 && gy <= cellsY/2 + 1) continue;
                if (Math.random() < 0.4 + waveNum * 0.02) {
                    const cx = gx * gridSize + gridSize / 2;
                    const cy = gy * gridSize + gridSize / 2;
                    const size = 40 + Math.random() * 60;
                    this.walls.push({ x: cx - size/2, y: cy - size/2, w: size, h: size, type: 'cell', cx: cx, cy: cy, radius: size / 2 });
                }
            }
        }
        const extraCount = 20 + waveNum * 3;
        for (let i = 0; i < extraCount; i++) {
            const size = 30 + Math.random() * 50;
            const x = 150 + Math.random() * (WORLD_W - 300);
            const y = 150 + Math.random() * (WORLD_H - 300);
            if (Math.hypot(x - WORLD_W/2, y - WORLD_H/2) < 300) continue;
            let overlap = false;
            for (const wall of this.walls) {
                if (wall.type === 'cell' && Math.hypot(x - wall.cx, y - wall.cy) < wall.radius + size/2 + 20) { overlap = true; break; }
            }
            if (!overlap) this.walls.push({ x: x - size/2, y: y - size/2, w: size, h: size, type: 'cell', cx: x, cy: y, radius: size / 2 });
        }
    }
    
    checkWall(x, y) {
        for (const w of this.walls) {
            if (w.type === 'cell') { if (Math.hypot(x - w.cx, y - w.cy) < w.radius) return true; }
            else { if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true; }
        }
        return false;
    }
    
    getWallNormal(x, y) {
        for (const w of this.walls) {
            if (w.type === 'cell') {
                const dist = Math.hypot(x - w.cx, y - w.cy);
                if (dist < w.radius + 10) return { x: (x - w.cx) / dist, y: (y - w.cy) / dist };
            }
        }
        if (x < 60) return { x: 1, y: 0 };
        if (x > WORLD_W - 60) return { x: -1, y: 0 };
        if (y < 60) return { x: 0, y: 1 };
        if (y > WORLD_H - 60) return { x: 0, y: -1 };
        return null;
    }
    
    escapeFromWall(entity) {
        if (!this.checkWall(entity.x, entity.y)) return false;
        for (let dist = 10; dist < 500; dist += 10) {
            for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
                const testX = entity.x + Math.cos(a) * dist;
                const testY = entity.y + Math.sin(a) * dist;
                if (!this.checkWall(testX, testY) && testX > 60 && testX < WORLD_W - 60 && testY > 60 && testY < WORLD_H - 60) {
                    entity.x = testX; entity.y = testY; return true;
                }
            }
        }
        return false;
    }
    
    addPlayer(socket, name, isHost = false) {
        const playerIndex = this.players.size;
        const colorData = PLAYER_COLORS[Math.min(playerIndex, PLAYER_COLORS.length - 1)];
        const player = {
            id: socket.id,
            name: name || 'Player',
            x: WORLD_W / 2 + (Math.random() - 0.5) * 200,
            y: WORLD_H / 2 + (Math.random() - 0.5) * 200,
            angle: 0,
            hp: 150, maxHp: 150,
            speed: 4.5, invincible: 60, dashing: false, dashTimer: 0,
            weaponLevels: { ...DEFAULT_WEAPON_LEVELS },
            equipped: { main: 'PLAZMER', allrange: 'PHALANX', tactical: 'DASH', ultimate: null },
            overload: { available: false, active: false, used: false, timer: 0 },
            thunderEnergy: 0, options: [], phalanxFormation: 'defense', score: 0,
            alive: true,
            lastInput: { x: 0, y: 0, angle: 0, dash: false },
            isHost: isHost, playerIndex: playerIndex, color: colorData.main, glowColor: colorData.glow, colorName: colorData.name,
            ready: isHost,
            respawnTimer: 0
        };
        this.players.set(socket.id, player);
        return player;
    }
    
    removePlayer(socketId) {
        this.players.delete(socketId);
        if (this.players.size === 0) rooms.delete(this.id);
    }
    
    startGame() {
        if (this.state !== 'waiting') return;
        this.state = 'playing';
        this.wave = 0; this.score = 0; this.frame = 0; this.waveTimer = 0;
        this.enemies = []; this.enemyBullets = []; this.items = [];
        this.generateWalls(0);
        io.to(this.id).emit('gameStart', { wave: this.wave });
    }
    
    startWave() {
        this.wave++;
        this.generateWalls(this.wave);
        this.currentBosses = [];
        this.enemies = this.enemies.filter(e => e.isBoss === false);
        this.players.forEach(player => {
            if (player.alive && this.checkWall(player.x, player.y)) this.escapeFromWall(player);
        });
        io.to(this.id).emit('waveStart', { wave: this.wave, walls: this.walls });
        
        let bossCount = 1;
        if (this.wave >= 50) bossCount = 3; else if (this.wave >= 20) bossCount = 2;
        if (this.wave % 10 === 0) bossCount += 1;
        const playerCount = this.players.size;
        const multiplayerScale = 1 + (playerCount - 1) * 0.5;
        
        setTimeout(() => {
            for (let i = 0; i < bossCount; i++) this.spawnBoss(multiplayerScale);
        }, 1500);
    }
    
    spawnBoss(multiplayerScale = 1) {
        const bossIndex = (this.wave - 1) % BOSS_TYPES.length;
        const template = BOSS_TYPES[bossIndex];
        let waveScale = 1 + Math.floor(this.wave / 5) * 1.0;
        if (this.wave > 20) waveScale *= (1 + (this.wave - 20) * 0.5);
        const pos = this.findSafeSpawnPosition(500);
        const boss = {
            id: 'boss_' + (this.enemyIdCounter++),
            type: 'boss', bossType: bossIndex, pattern: template.pattern, name: template.name,
            x: pos.x, y: pos.y,
            hp: Math.floor(template.baseHp * waveScale * multiplayerScale * 1.5),
            maxHp: Math.floor(template.baseHp * waveScale * multiplayerScale * 1.5),
            speed: 1.5, size: template.size + Math.floor(this.wave / 5) * 2, color: template.color,
            score: 3000 + this.wave * 500, isBoss: true, timer: 0, attackTimer: 0, phase: 0
        };
        this.enemies.push(boss);
        this.currentBosses.push(boss);
        io.to(this.id).emit('bossSpawn', { boss: this.sanitizeEnemy(boss), bossCount: this.currentBosses.filter(b => b.hp > 0).length });
    }
    
    spawnEnemy(type, x, y) {
        const template = ENEMY_TYPES[type];
        if (!template) return null;
        let waveScale = 1 + this.wave * 0.1;
        let speedMult = 1;
        if (this.wave > 20) {
            const hardModeFactor = 1 + Math.pow((this.wave - 20) * 0.1, 2);
            waveScale *= hardModeFactor;
            speedMult = 1.3 + Math.min(0.5, (this.wave - 20) * 0.02);
        }
        const enemy = {
            id: 'e_' + (this.enemyIdCounter++),
            type, x, y,
            hp: Math.floor(template.hp * waveScale), maxHp: Math.floor(template.hp * waveScale),
            speed: Math.min(template.speed * 2.5 * speedMult, (template.speed + this.wave * 0.05) * speedMult),
            size: template.size, color: template.color, score: template.score,
            shoots: template.shoots || false, armor: template.armor || false, divides: template.divides || false,
            isBoss: false, timer: Math.floor(Math.random() * 60), phase: Math.random() * Math.PI * 2
        };
        this.enemies.push(enemy);
        return enemy;
    }
    
    spawnMobs() {
        const activeBosses = this.currentBosses.filter(b => b.hp > 0);
        if (activeBosses.length === 0) return;
        const maxMobs = Math.min(150, 30 + this.wave * 2);
        const mobCount = this.enemies.filter(e => !e.isBoss && e.hp > 0).length;
        if (mobCount >= maxMobs) return;
        const batchSize = 1 + Math.floor(this.wave / 10);
        for (let i = 0; i < batchSize; i++) {
            const pos = this.findSafeSpawnPosition(250);
            const types = ['virus', 'bacteria'];
            if (this.wave >= 2) types.push('infected', 'toxin');
            if (this.wave >= 4) types.push('mutant', 'parasite');
            if (this.wave >= 6) types.push('cancer');
            if (this.wave >= 8) types.push('tumor', 'plague');
            if (this.wave >= 10) types.push('necrosis');
            const type = types[Math.floor(Math.random() * types.length)];
            this.spawnEnemy(type, pos.x, pos.y);
        }
    }
    
    findSafeSpawnPosition(minDist) {
        for (let i = 0; i < 50; i++) {
            const x = 150 + Math.random() * (WORLD_W - 300);
            const y = 150 + Math.random() * (WORLD_H - 300);
            if (this.checkWall(x, y)) continue;
            let tooClose = false;
            this.players.forEach(player => {
                if (player.alive && Math.hypot(player.x - x, player.y - y) < minDist) tooClose = true;
            });
            if (tooClose) continue;
            return { x, y };
        }
        return { x: WORLD_W - 300, y: WORLD_H - 300 };
    }
    
    // ========== UPDATE関数（ここを大幅修正して確実にしました） ==========
    update() {
        if (this.state === 'waiting') return;
        
        this.frame++;
        
        // ★リスポーン管理（最優先・独立して実行）
        this.players.forEach(player => {
            // 死んでいる場合のみ処理
            if (!player.alive) {
                // 安全策：undefinedなら0にする
                if (typeof player.respawnTimer !== 'number') player.respawnTimer = 0;
                
                // カウントアップ
                player.respawnTimer++;
                
                // デバッグログ（サーバーコンソールで確認用）
                if (player.respawnTimer % 60 === 0) {
                    console.log(`[DEBUG] Player ${player.name} dead. Timer: ${player.respawnTimer}/180`);
                }

                // 3秒（180フレーム）経過で復活
                if (player.respawnTimer >= 180) {
                    this.respawnPlayer(player);
                }
            } else {
                // 生きているプレイヤーのタイマー・無敵・オーバーロード更新
                if (player.invincible > 0) player.invincible--;
                if (player.overload && player.overload.active) {
                    player.overload.timer--;
                    if (player.overload.timer <= 0) player.overload.active = false;
                }
            }
        });
        
        if (this.state === 'weaponSelect') {
            this.broadcastState();
            return;
        }
        
        // --- ゲーム進行 ---
        this.waveTimer++;
        this.mobTimer++;
        
        if (this.wave === 0 && this.waveTimer > 60) this.startWave();
        if (this.mobTimer >= 60) { this.mobTimer = 0; this.spawnMobs(); }
        
        // 生きているプレイヤーの更新
        this.players.forEach(player => {
            if (player.alive) this.updatePlayer(player);
        });
        
        this.updateEnemies();
        this.updateEnemyBullets();
        this.updateItems();
        
        // ボス全滅判定
        const activeBosses = this.currentBosses.filter(b => b.hp > 0);
        if (this.currentBosses.length > 0 && activeBosses.length === 0) {
            this.currentBosses = [];
            this.enemies.forEach(e => {
                if (!e.isBoss && e.hp > 0) { e.hp = 0; this.score += 50; }
            });
            io.to(this.id).emit('bossDefeated', { wave: this.wave, score: this.score });
            setTimeout(() => {
                if (this.state === 'playing') {
                    this.state = 'weaponSelect';
                    this.players.forEach(p => p.loadoutReady = false);
                    io.to(this.id).emit('weaponSelect', { 
                        nextWave: this.wave + 1,
                        players: Array.from(this.players.values()).map(p => ({ id: p.id, name: p.name, loadoutReady: false }))
                    });
                }
            }, 3000);
        }
        
        if (this.frame % 2 === 0) this.broadcastState();
    }
    
    updatePlayer(player) {
        // ★修正済み：ここには「生きているプレイヤー」しか来ないため、死んでいる判定は不要
        
        if (this.checkWall(player.x, player.y) && !player.dashing) {
            this.escapeFromWall(player);
        }
        
        if (player.dashing) {
            player.dashTimer--;
            const vx = Math.cos(player.angle) * 35;
            const vy = Math.sin(player.angle) * 35;
            player.x += vx; player.y += vy;
            player.x = Math.max(60, Math.min(WORLD_W - 60, player.x));
            player.y = Math.max(60, Math.min(WORLD_H - 60, player.y));
            
            if (!player.dashHitEnemies) player.dashHitEnemies = new Set();
            this.enemies.forEach(e => {
                if (e.hp <= 0) return;
                if (player.dashHitEnemies.has(e.id)) return;
                const dist = Math.hypot(e.x - player.x, e.y - player.y);
                if (dist < e.size + 20) {
                    const damage = 15;
                    player.dashHitEnemies.add(e.id);
                    e.hp -= damage;
                    io.to(this.id).emit('enemyDamaged', { enemyId: e.id, damage, x: e.x, y: e.y, weaponType: 'DASH' });
                    if (e.hp <= 0) {
                        this.score += e.score || 100;
                        io.to(this.id).emit('enemyDefeated', { enemyId: e.id, x: e.x, y: e.y, isBoss: e.isBoss });
                        this.dropItems(e.x, e.y, e.isBoss);
                    }
                }
            });
            
            if (player.dashTimer <= 0) {
                player.dashing = false;
                player.dashHitEnemies.clear();
                if (this.checkWall(player.x, player.y)) this.escapeFromWall(player);
            }
        } else {
            const input = player.lastInput;
            if (input.moving) {
                const vx = Math.cos(input.angle) * player.speed;
                const vy = Math.sin(input.angle) * player.speed;
                if (!this.checkWall(player.x + vx, player.y)) player.x += vx;
                if (!this.checkWall(player.x, player.y + vy)) player.y += vy;
            }
            player.angle = input.angle;
        }
        player.x = Math.max(60, Math.min(WORLD_W - 60, player.x));
        player.y = Math.max(60, Math.min(WORLD_H - 60, player.y));
        if (player.weaponLevels.THUNDER > 0 && player.thunderEnergy < 180) player.thunderEnergy++;
        this.enemies.forEach(enemy => {
            if (enemy.hp <= 0) return;
            if (Math.hypot(player.x - enemy.x, player.y - enemy.y) < 8 + enemy.size) {
                if (!player.dashing && player.invincible <= 0) {
                    this.damagePlayer(player, enemy.isBoss ? 20 : 10);
                }
            }
        });
    }
    
    respawnPlayer(player) {
        const pos = this.findSafeSpawnPosition(300);
        player.x = pos.x;
        player.y = pos.y;
        player.hp = player.maxHp;
        player.alive = true;
        player.invincible = 180;
        player.respawnTimer = 0;
        player.dashing = false;
        player.dashTimer = 0;
        
        player.weaponLevels.PLAZMER = Math.max(1, Math.floor(player.weaponLevels.PLAZMER / 2));
        player.weaponLevels.HOMING = Math.floor(player.weaponLevels.HOMING / 2);
        player.weaponLevels.LASER = Math.floor(player.weaponLevels.LASER / 2);
        player.weaponLevels.THUNDER = Math.floor(player.weaponLevels.THUNDER / 2);
        player.weaponLevels.PHALANX = Math.floor(player.weaponLevels.PHALANX / 2);
        
        const newOptionCount = Math.floor(player.options.length / 2);
        player.options = player.options.slice(0, newOptionCount);
        
        io.to(player.id).emit('respawned', {
            x: player.x, y: player.y, hp: player.hp,
            weaponLevels: player.weaponLevels, options: player.options.length
        });
        io.to(this.id).emit('playerRespawned', { playerId: player.id, name: player.name });
        
        console.log(`[DEBUG] Player ${player.name} RESPAWNED!`);
    }
    
    updateEnemies() {
        const findNearestPlayer = (x, y) => {
            let nearest = null, minDist = Infinity;
            this.players.forEach(player => {
                if (!player.alive) return;
                const d = Math.hypot(player.x - x, player.y - y);
                if (d < minDist) { minDist = d; nearest = player; }
            });
            return nearest;
        };
        
        this.enemies.forEach(enemy => {
            if (enemy.hp <= 0) return;
            enemy.timer++;
            if (enemy.anchored) {
                enemy.anchorTimer--;
                if (enemy.anchorTimer <= 0) enemy.anchored = false;
                return;
            }
            if (this.checkWall(enemy.x, enemy.y)) this.escapeFromWall(enemy);
            
            const target = findNearestPlayer(enemy.x, enemy.y);
            if (target) {
                const angle = Math.atan2(target.y - enemy.y, target.x - enemy.x);
                const vx = Math.cos(angle) * enemy.speed;
                const vy = Math.sin(angle) * enemy.speed;
                if (!this.checkWall(enemy.x + vx, enemy.y + vy)) { enemy.x += vx; enemy.y += vy; }
                else {
                    if (!this.checkWall(enemy.x + vx, enemy.y)) enemy.x += vx;
                    else if (!this.checkWall(enemy.x, enemy.y + vy)) enemy.y += vy;
                }
                if (enemy.shoots && enemy.timer % 90 === 0) {
                    const a = Math.atan2(target.y - enemy.y, target.x - enemy.x);
                    this.enemyBullets.push({
                        id: 'eb_' + this.enemyIdCounter++, x: enemy.x, y: enemy.y,
                        vx: Math.cos(a) * 5, vy: Math.sin(a) * 5, life: 120, size: 5, color: enemy.color
                    });
                }
                if (enemy.isBoss) { enemy.attackTimer++; this.bossAttack(enemy, target); }
            }
        });
        this.enemies = this.enemies.filter(e => e.hp > 0);
    }
    
    bossAttack(boss, target) {
        const angle = Math.atan2(target.y - boss.y, target.x - boss.x);
        switch (boss.pattern) {
            case 'radial':
                if (boss.attackTimer % 60 === 0) {
                    for (let i = 0; i < 16; i++) {
                        const a = (Math.PI * 2 / 16) * i + boss.phase;
                        this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a) * 4, vy: Math.sin(a) * 4, life: 150, size: 6, color: boss.color });
                    }
                    boss.phase += 0.2;
                }
                break;
            case 'spiral':
                if (boss.attackTimer % 8 === 0) {
                    const a = boss.timer * 0.15;
                    this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a) * 5, vy: Math.sin(a) * 5, life: 120, size: 5, color: boss.color });
                }
                break;
            case 'burst':
                if (boss.attackTimer % 40 === 0) {
                    for (let i = 0; i < 8; i++) {
                        const a = angle + (Math.random() - 0.5) * 0.8;
                        const speed = 4 + Math.random() * 3;
                        this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: 60, size: 8, color: '#f80' });
                    }
                }
                break;
            case 'swarm':
                if (boss.attackTimer % 5 === 0) {
                    const a = angle + (Math.random() - 0.5) * 1.5;
                    this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a) * 6, vy: Math.sin(a) * 6, life: 80, size: 4, color: boss.color });
                }
                break;
            case 'laser':
                if (boss.attackTimer % 90 === 0) {
                    for (let i = 0; i < 8; i++) {
                        const a = (Math.PI * 2 / 8) * i + boss.phase;
                        for (let j = 0; j < 20; j++) {
                            this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x + Math.cos(a) * j * 25, y: boss.y + Math.sin(a) * j * 25, vx: Math.cos(a) * 8, vy: Math.sin(a) * 8, life: 40, size: 4, color: '#f00' });
                        }
                    }
                    boss.phase += 0.3;
                }
                break;
            case 'chaos':
                if (boss.attackTimer % 20 === 0) {
                    for (let i = 0; i < 3; i++) {
                        const a = boss.timer * 0.2 + i * (Math.PI * 2 / 3);
                        this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a) * 5, vy: Math.sin(a) * 5, life: 150, size: 6, color: '#ff0' });
                    }
                }
                if (boss.attackTimer % 60 === 0) {
                    for (let i = 0; i < 24; i++) {
                        const a = (Math.PI * 2 / 24) * i;
                        this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a) * 3, vy: Math.sin(a) * 3, life: 200, size: 8, color: '#f80' });
                    }
                }
                break;
            case 'nightmare':
                if (boss.attackTimer % 30 === 0) {
                    for (let i = 0; i < 5; i++) {
                        const spreadAngle = angle + (i - 2) * 0.2;
                        this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(spreadAngle) * 7, vy: Math.sin(spreadAngle) * 7, life: 100, size: 10, color: '#f44', homing: true, target: target });
                    }
                }
                if (boss.attackTimer % 15 === 0) {
                    for (let i = 0; i < 6; i++) {
                        const a = boss.timer * 0.1 + i * (Math.PI / 3);
                        this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a) * 4, vy: Math.sin(a) * 4, life: 180, size: 5, color: '#a44' });
                    }
                }
                break;
            case 'apocalypse':
                if (boss.attackTimer % 10 === 0) {
                    const a1 = boss.timer * 0.3; const a2 = boss.timer * 0.3 + Math.PI;
                    this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a1) * 6, vy: Math.sin(a1) * 6, life: 200, size: 7, color: '#a0f' });
                    this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a2) * 6, vy: Math.sin(a2) * 6, life: 200, size: 7, color: '#f0a' });
                }
                if (boss.attackTimer % 45 === 0) {
                    for (let i = 0; i < 32; i++) {
                        const a = (Math.PI * 2 / 32) * i + boss.phase; const speed = 3 + (i % 2) * 2;
                        this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: 250, size: 6, color: '#f0f' });
                    }
                    boss.phase += 0.1;
                }
                if (boss.attackTimer % 120 === 0) {
                    for (let dir = 0; dir < 4; dir++) {
                        const baseA = dir * (Math.PI / 2);
                        for (let j = 0; j < 30; j++) {
                            this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x + Math.cos(baseA) * j * 20, y: boss.y + Math.sin(baseA) * j * 20, vx: Math.cos(baseA) * 10, vy: Math.sin(baseA) * 10, life: 30, size: 8, color: '#fff' });
                        }
                    }
                }
                break;
            case 'all':
                const phase = Math.floor(boss.attackTimer / 120) % 5;
                if (phase === 0 && boss.attackTimer % 20 === 0) {
                    const a1 = boss.timer * 0.2; const a2 = boss.timer * 0.2 + Math.PI;
                    this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a1) * 5, vy: Math.sin(a1) * 5, life: 150, size: 6, color: '#fff' });
                    this.enemyBullets.push({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a2) * 5, vy: Math.sin(a2) * 5, life: 150, size: 6, color: '#fff' });
                }
                // (以下略、元のコードと同じ)
                break;
        }
    }
    
    updateEnemyBullets() {
        this.enemyBullets.forEach(b => {
            if (b.homing && b.target) {
                const player = this.players.get(b.target.id);
                if (player && player.alive) {
                    const angleToPlayer = Math.atan2(player.y - b.y, player.x - b.x);
                    const currentAngle = Math.atan2(b.vy, b.vx);
                    let angleDiff = angleToPlayer - currentAngle;
                    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                    const turnSpeed = 0.08;
                    const newAngle = currentAngle + Math.max(-turnSpeed, Math.min(turnSpeed, angleDiff));
                    const speed = Math.hypot(b.vx, b.vy);
                    b.vx = Math.cos(newAngle) * speed; b.vy = Math.sin(newAngle) * speed;
                }
            }
            b.x += b.vx; b.y += b.vy; b.life--;
            if (b.life <= 0 || this.checkWall(b.x, b.y)) { b.dead = true; return; }
            this.players.forEach(player => {
                if (!player.alive || player.invincible > 0 || player.dashing) return;
                if (Math.hypot(player.x - b.x, player.y - b.y) < 8 + b.size) { this.damagePlayer(player, 8); b.dead = true; }
            });
        });
        this.enemyBullets = this.enemyBullets.filter(b => !b.dead);
        if (this.enemyBullets.length > MAX_ENEMY_BULLETS) this.enemyBullets = this.enemyBullets.slice(-MAX_ENEMY_BULLETS);
    }
    
    updateItems() {
        this.items.forEach(item => {
            if (this.checkWall(item.x, item.y)) {
                for (let dist = 20; dist < 200; dist += 20) {
                    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
                        const testX = item.x + Math.cos(a) * dist; const testY = item.y + Math.sin(a) * dist;
                        if (!this.checkWall(testX, testY)) { item.x = testX; item.y = testY; break; }
                    }
                    if (!this.checkWall(item.x, item.y)) break;
                }
            }
            this.players.forEach(player => {
                if (!player.alive) return;
                const dist = Math.hypot(player.x - item.x, player.y - item.y);
                if (dist < 400) {
                    const pullStrength = 0.15 + (1 - dist / 400) * 0.2;
                    item.x += (player.x - item.x) * pullStrength; item.y += (player.y - item.y) * pullStrength;
                }
                if (dist < 80) { this.collectItem(player, item); item.collected = true; }
            });
        });
        this.items = this.items.filter(i => !i.collected);
    }
    
    collectItem(player, item) {
        if (item.type === 'H') player.hp = Math.min(player.maxHp, player.hp + 30);
        else if (item.type === 'PHALANX') {
            if (player.options.length < 6) player.options.push({ x: player.x, y: player.y, angle: 0 });
            player.weaponLevels.PHALANX++;
        } else player.weaponLevels[item.type] = (player.weaponLevels[item.type] || 0) + 1;
        io.to(player.id).emit('itemCollected', { type: item.type, weaponLevels: player.weaponLevels, hp: player.hp, options: player.options.length });
    }
    
    damagePlayer(player, damage) {
        if (player.invincible > 0 || player.dashing) return;
        player.hp -= damage;
        player.invincible = 30;
        io.to(player.id).emit('playerDamaged', { hp: player.hp, damage });
        if (player.hp <= 0) {
            player.alive = false;
            // ★死んだ瞬間にタイマーを0リセット（これで確実にカウントが始まる）
            player.respawnTimer = 0; 
            io.to(this.id).emit('playerDied', { playerId: player.id, name: player.name });
            console.log(`[DEBUG] Player ${player.name} DIED. Timer reset to 0.`);
        }
    }
    
    // ... damageEnemy, defeatEnemy, dropItems, handlePlayerInput, handlePlayerShoot ...
    // (これらは以前と同じため省略)
    damageEnemy(enemyId, damage, weaponType, attackerId) {
        const enemy = this.enemies.find(e => e.id === enemyId);
        if (!enemy || enemy.hp <= 0) return;
        if (enemy.armor && weaponType !== 'THUNDER' && weaponType !== 'LASER') damage = Math.floor(damage / 2);
        enemy.hp -= damage;
        if (enemy.hp <= 0) this.defeatEnemy(enemy, attackerId);
        return enemy.hp;
    }
    
    defeatEnemy(enemy, attackerId) {
        const attacker = this.players.get(attackerId);
        if (attacker) attacker.score += enemy.score;
        this.score += enemy.score;
        this.dropItems(enemy.x, enemy.y, enemy.isBoss);
        if (enemy.divides && !enemy.isBoss) {
            for (let i = 0; i < 2; i++) {
                const a = Math.random() * Math.PI * 2;
                this.spawnEnemy('virus', enemy.x + Math.cos(a) * 30, enemy.y + Math.sin(a) * 30);
            }
        }
        io.to(this.id).emit('enemyDefeated', { enemyId: enemy.id, isBoss: enemy.isBoss, score: this.score });
    }
    
    dropItems(x, y, isBoss) {
        // (省略：同じ)
        // コードが長すぎるため、ここだけは以前の dropItems をそのまま使ってください
        // 中身は変更ありません
        const WEAPON_COLORS = { PLAZMER:'#00FFFF',PHALANX:'#00FF66',HOMING:'#AA66FF',INTERCEPT:'#66CCFF',LASER:'#00CCFF',REFLECT:'#CCFFFF',RIFT:'#FF44CC',ANCHOR:'#663399',THUNDER:'#FFFF33',DASH:'#FF9933',PIERCE:'#CC3333',H:'#FF6666' };
        const WAVE_UNLOCK = { 1:['PLAZMER','PHALANX'],3:['HOMING'],4:['INTERCEPT'],6:['LASER'],7:['REFLECT'],8:['RIFT'],10:['ANCHOR'],12:['THUNDER'],14:['DASH'],16:['PIERCE'],20:['OVERLOAD'] };
        const getUnlockedWeapons = () => { const unlocked=[]; for(let w=1;w<=this.wave;w++) if(WAVE_UNLOCK[w]) unlocked.push(...WAVE_UNLOCK[w]); return unlocked.filter(w=>w!=='OVERLOAD'); };
        const findSafeItemPos = (baseX,baseY) => {
            if(!this.checkWall(baseX,baseY)) return{x:baseX,y:baseY};
            for(let dist=20;dist<150;dist+=20) for(let a=0;a<Math.PI*2;a+=Math.PI/8) {
                const tx=baseX+Math.cos(a)*dist, ty=baseY+Math.sin(a)*dist;
                if(!this.checkWall(tx,ty)&&tx>60&&tx<WORLD_W-60&&ty>60&&ty<WORLD_H-60) return{x:tx,y:ty};
            }
            return{x:baseX,y:baseY};
        };
        if(isBoss){
            const newWeapons=WAVE_UNLOCK[this.wave]||[]; const unlockedWeapons=getUnlockedWeapons();
            newWeapons.forEach((type,i)=>{ if(type==='OVERLOAD')return; const a=(Math.PI*2/Math.max(1,newWeapons.length))*i; const p=findSafeItemPos(x+Math.cos(a)*50,y+Math.sin(a)*50); this.items.push({id:'item_'+this.enemyIdCounter++,x:p.x,y:p.y,type:type,color:WEAPON_COLORS[type]||'#fff',isNew:true}); });
            const hpCount=3+Math.floor(this.wave/5); for(let i=0;i<hpCount;i++){ const a=Math.random()*Math.PI*2; const d=30+Math.random()*80; const p=findSafeItemPos(x+Math.cos(a)*d,y+Math.sin(a)*d); this.items.push({id:'item_'+this.enemyIdCounter++,x:p.x,y:p.y,type:'H',color:WEAPON_COLORS.H}); }
            const upCount=2+Math.floor(Math.random()*3); for(let i=0;i<upCount;i++){ const t=unlockedWeapons[Math.floor(Math.random()*unlockedWeapons.length)]; if(!t)continue; const a=Math.random()*Math.PI*2; const d=60+Math.random()*60; const p=findSafeItemPos(x+Math.cos(a)*d,y+Math.sin(a)*d); this.items.push({id:'item_'+this.enemyIdCounter++,x:p.x,y:p.y,type:t,color:WEAPON_COLORS[t]||'#fff'}); }
        } else {
            if(Math.random()<0.20){ const p=findSafeItemPos(x,y); this.items.push({id:'item_'+this.enemyIdCounter++,x:p.x,y:p.y,type:'H',color:WEAPON_COLORS.H}); }
            if(Math.random()<0.08){ const t=getUnlockedWeapons()[Math.floor(Math.random()*getUnlockedWeapons().length)]; if(t){ const p=findSafeItemPos(x,y); this.items.push({id:'item_'+this.enemyIdCounter++,x:p.x,y:p.y,type:t,color:WEAPON_COLORS[t]||'#fff'}); } }
        }
    }
    
    handlePlayerInput(socketId, input) {
        const player = this.players.get(socketId);
        if (!player || !player.alive) return;
        player.lastInput = input;
        if (input.x !== undefined && input.y !== undefined) {
            const dist = Math.hypot(input.x - player.x, input.y - player.y);
            if (dist < player.speed * 3) { player.x = input.x; player.y = input.y; }
        }
        if (input.dash && !player.dashing) {
            player.dashing = true; player.dashTimer = 10; player.invincible = Math.max(player.invincible, 12);
        }
    }
    
    handlePlayerShoot(socketId, data) {
        const player = this.players.get(socketId);
        if (!player || !player.alive) return;
        if (data.hits && data.hits.length > 0) {
            data.hits.forEach(hit => { this.damageEnemy(hit.enemyId, hit.damage, hit.weaponType, socketId); });
        }
    }
    
    sanitizePlayer(player) {
        return {
            id: player.id, name: player.name, x: player.x, y: player.y, angle: player.angle,
            hp: player.hp, maxHp: player.maxHp, invincible: player.invincible, dashing: player.dashing, alive: player.alive,
            weaponLevels: player.weaponLevels, thunderEnergy: player.thunderEnergy, options: player.options, formation: player.formation, score: player.score,
            isHost: player.isHost, playerIndex: player.playerIndex, color: player.color, glowColor: player.glowColor, colorName: player.colorName, ready: player.ready,
            respawnTimer: player.respawnTimer // ★これが送られていることが重要
        };
    }
    
    sanitizeEnemy(enemy) {
        return {
            id: enemy.id, type: enemy.type, x: enemy.x, y: enemy.y, hp: enemy.hp, maxHp: enemy.maxHp,
            size: enemy.size, color: enemy.color, isBoss: enemy.isBoss, name: enemy.name, pattern: enemy.pattern
        };
    }
    
    broadcastState() {
        const state = {
            frame: this.frame, wave: this.wave, score: this.score,
            players: Array.from(this.players.values()).map(p => this.sanitizePlayer(p)),
            enemies: this.enemies.map(e => this.sanitizeEnemy(e)),
            enemyBullets: this.enemyBullets.map(b => ({ id: b.id, x: b.x, y: b.y, size: b.size, color: b.color })),
            items: this.items,
            bossCount: this.currentBosses.filter(b => b.hp > 0).length
        };
        io.to(this.id).emit('gameState', state);
    }
}

// ... generateRoomCode, PLAYER_COLORS, socket logic ...
// (これらも変更なしのため省略していますが、元のコードのままでOKです)
// 元のコードの io.on('connection') 以降をそのまま使用してください

function generateRoomCode() {
    let code; do { code = Math.floor(1000 + Math.random() * 9000).toString(); } while (rooms.has(code)); return code;
}
const PLAYER_COLORS = [ { main:'#ffffff',glow:'#0ff',name:'WHITE' }, { main:'#ff4444',glow:'#f00',name:'RED' }, { main:'#aa44ff',glow:'#a0f',name:'PURPLE' }, { main:'#4488ff',glow:'#08f',name:'BLUE' } ];

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    let currentRoom = null;
    socket.on('hostRoom', (data) => {
        const playerName = data.name || 'Host'; const roomId = generateRoomCode();
        const room = new GameRoom(roomId); room.hostId = socket.id; rooms.set(roomId, room);
        currentRoom = room; socket.join(roomId);
        const player = currentRoom.addPlayer(socket, playerName, true);
        socket.emit('hosted', { playerId: socket.id, roomId: roomId, player: currentRoom.sanitizePlayer(player), walls: currentRoom.walls, state: currentRoom.state, wave: currentRoom.wave, players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p)) });
        console.log(`Player ${playerName} hosted room ${roomId}`);
    });
    socket.on('joinRoom', (data) => {
        const roomId = data.roomId; const playerName = data.name || 'Player';
        if (!rooms.has(roomId)) { socket.emit('joinError', { message: `Room ${roomId} not found!` }); return; }
        const room = rooms.get(roomId);
        if (room.players.size >= 4) { socket.emit('joinError', { message: 'Room is full! (Max 4 players)' }); return; }
        if (room.state === 'playing') { socket.emit('joinError', { message: 'Game already in progress!' }); return; }
        currentRoom = room; socket.join(roomId);
        const player = currentRoom.addPlayer(socket, playerName, false);
        socket.emit('joined', { playerId: socket.id, roomId: roomId, player: currentRoom.sanitizePlayer(player), walls: currentRoom.walls, state: currentRoom.state, wave: currentRoom.wave, players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p)), isGuest: true });
        socket.to(roomId).emit('playerJoined', { player: currentRoom.sanitizePlayer(player), players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p)) });
        console.log(`Player ${playerName} joined room ${roomId} as Guest ${player.playerIndex}`);
    });
    socket.on('playerReady', () => { if (!currentRoom) return; const player = currentRoom.players.get(socket.id); if (player && !player.isHost) { player.ready = true; io.to(currentRoom.id).emit('playerReadyUpdate', { playerId: socket.id, players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p)) }); console.log(`Player ${player.name} is READY in room ${currentRoom.id}`); } });
    socket.on('startGame', () => { if (!currentRoom) return; if (currentRoom.hostId !== socket.id) return; if (currentRoom.state !== 'waiting') return; currentRoom.startGame(); io.to(currentRoom.id).emit('gameStarted', { players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p)) }); console.log(`Game started in room ${currentRoom.id}`); });
    socket.on('loadoutReady', (data) => { if (!currentRoom || currentRoom.state !== 'weaponSelect') return; const player = currentRoom.players.get(socket.id); if (!player) return; if (data.passive && Array.isArray(data.passive)) { player.equipped = { passive: data.passive, active: data.active || null }; } player.loadoutReady = true; io.to(currentRoom.id).emit('loadoutReadyUpdate', { playerId: socket.id, players: Array.from(currentRoom.players.values()).map(p => ({ id: p.id, name: p.name, loadoutReady: p.loadoutReady || false })) }); const allReady = Array.from(currentRoom.players.values()).every(p => p.loadoutReady); if (allReady) { setTimeout(() => { currentRoom.players.forEach(p => p.loadoutReady = false); currentRoom.state = 'playing'; currentRoom.startWave(); io.to(currentRoom.id).emit('waveStarting'); }, 1000); } });
    socket.on('cancelHost', () => { if (currentRoom) { io.to(currentRoom.id).emit('hostCancelled'); rooms.delete(currentRoom.id); currentRoom = null; } });
    socket.on('input', (input) => { if (currentRoom) { currentRoom.handlePlayerInput(socket.id, input); } });
    socket.on('shoot', (data) => { if (currentRoom) { currentRoom.handlePlayerShoot(socket.id, data); } });
    socket.on('hit', (data) => { if (currentRoom) { const remainingHp = currentRoom.damageEnemy(data.enemyId, data.damage, data.weaponType, socket.id); io.to(currentRoom.id).emit('enemyHit', { enemyId: data.enemyId, damage: data.damage, remainingHp: remainingHp }); } });
    socket.on('destroyBullet', (data) => { if (currentRoom) { const idx = currentRoom.enemyBullets.findIndex(b => b.id === data.bulletId); if (idx !== -1) { currentRoom.enemyBullets.splice(idx, 1); } } });
    socket.on('interceptExplosion', (data) => { if (currentRoom) { currentRoom.enemyBullets = currentRoom.enemyBullets.filter(b => { const dist = Math.hypot(b.x - data.x, b.y - data.y); return dist > data.radius; }); } });
    socket.on('anchorEnemy', (data) => { if (currentRoom) { const enemy = currentRoom.enemies.find(e => e.id === data.enemyId); if (enemy) { enemy.anchored = true; enemy.anchorTimer = 180; io.to(currentRoom.id).emit('enemyAnchored', { enemyId: data.enemyId }); } } });
    socket.on('reflectBullet', (data) => { if (currentRoom) { const bullet = currentRoom.enemyBullets.find(b => b.id === data.bulletId); if (bullet) { const speed = Math.hypot(bullet.vx, bullet.vy) * 1.5; bullet.vx = Math.cos(data.newAngle) * speed; bullet.vy = Math.sin(data.newAngle) * speed; bullet.reflected = true; bullet.color = '#0af'; io.to(currentRoom.id).emit('bulletReflected', { bulletId: data.bulletId, angle: data.newAngle }); } } });
    socket.on('fire', (data) => { if (currentRoom) { const player = currentRoom.players.get(socket.id); if (player) { if (data.type === 'THUNDER') { player.thunderEnergy = 0; } socket.to(currentRoom.id).emit('remoteFire', { playerId: socket.id, type: data.type, angle: data.angle, x: player.x, y: player.y }); } } });
    socket.on('overloadActivate', () => { if (!currentRoom) return; const player = currentRoom.players.get(socket.id); if (!player || !player.alive) return; const hpRatio = player.hp / (player.maxHp || 100); if (hpRatio > 0.5) return; if (player.overload.used) return; if (currentRoom.wave < 22) return; player.overload.active = true; player.overload.used = true; player.overload.timer = 480; player.invincible = 480; currentRoom.enemies.forEach(e => { if (e.hp > 0) { const damage = e.isBoss ? Math.floor(e.maxHp * 0.3) : 999; e.hp -= damage; if (e.hp <= 0) { currentRoom.score += e.score || 100; } } }); currentRoom.enemyBullets = []; io.to(currentRoom.id).emit('overloadActivated', { playerId: socket.id, playerName: player.name }); console.log(`${player.name} activated OVERLOAD!`); });
    socket.on('formation', (data) => { if (currentRoom) { const player = currentRoom.players.get(socket.id); if (player) { player.formation = data.formation; } } });
    socket.on('disconnect', () => { console.log('Player disconnected:', socket.id); if (currentRoom) { currentRoom.removePlayer(socket.id); socket.to(currentRoom.id).emit('playerLeft', { playerId: socket.id }); } });
});

setInterval(() => { rooms.forEach(room => { room.update(); }); }, TICK_INTERVAL);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`PLAZMERS Server running on port ${PORT}`); });
