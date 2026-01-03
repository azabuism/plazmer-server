const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

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

// ========== 敵テンプレート ==========
const ENEMY_TYPES = {
    virus: { hp: 5, speed: 2, size: 10, color: '#0f0', score: 50 },
    bacteria: { hp: 8, speed: 1.5, size: 14, color: '#0a0', score: 60 },
    infected: { hp: 15, speed: 1.8, size: 18, color: '#ff0', score: 100, shoots: true },
    mutant: { hp: 25, speed: 2.2, size: 16, color: '#f80', score: 150 },
    toxin: { hp: 12, speed: 2.5, size: 12, color: '#f0f', score: 120 },
    parasite: { hp: 35, speed: 1.2, size: 22, color: '#88f', score: 200, armor: true },
    cancer: { hp: 50, speed: 1, size: 30, color: '#800', score: 300, divides: true },
    tumor: { hp: 80, speed: 0.5, size: 40, color: '#400', score: 400 },
    plague: { hp: 60, speed: 2, size: 25, color: '#0ff', score: 350, shoots: true },
    necrosis: { hp: 100, speed: 0.8, size: 35, color: '#444', score: 500, armor: true }
};

const BOSS_TYPES = [
    { name: 'VIRUS-α', color: '#0f0', baseHp: 300, size: 50, pattern: 'radial' },
    { name: 'BACTERIA-β', color: '#08f', baseHp: 450, size: 55, pattern: 'spiral' },
    { name: 'INFECTION-γ', color: '#f80', baseHp: 600, size: 60, pattern: 'burst' },
    { name: 'CANCER-δ', color: '#f00', baseHp: 800, size: 70, pattern: 'divide' },
    { name: 'PLAGUE-ε', color: '#f0f', baseHp: 1000, size: 75, pattern: 'swarm' },
    { name: 'NECROSIS-ζ', color: '#888', baseHp: 1200, size: 80, pattern: 'laser' },
    { name: 'PANDEMIC-η', color: '#ff0', baseHp: 1500, size: 85, pattern: 'chaos' },
    { name: 'OMEGA-CELL', color: '#fff', baseHp: 2000, size: 100, pattern: 'all' }
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
        this.state = 'waiting'; // waiting, playing, gameover
        this.frame = 0;
        this.enemyIdCounter = 0;
        this.waveTimer = 0;
        this.mobTimer = 0;
        this.currentBosses = [];
        this.lastUpdate = Date.now();
        
        this.generateWalls(0);
    }
    
    generateWalls(waveNum) {
        this.walls = [];
        const thickness = 50;
        
        // 外壁
        this.walls.push({ x: 0, y: 0, w: WORLD_W, h: thickness, type: 'border' });
        this.walls.push({ x: 0, y: WORLD_H - thickness, w: WORLD_W, h: thickness, type: 'border' });
        this.walls.push({ x: 0, y: 0, w: thickness, h: WORLD_H, type: 'border' });
        this.walls.push({ x: WORLD_W - thickness, y: 0, w: thickness, h: WORLD_H, type: 'border' });
        
        // 迷路風の壁
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
                    
                    this.walls.push({
                        x: cx - size/2, y: cy - size/2,
                        w: size, h: size,
                        type: 'cell',
                        cx: cx, cy: cy, radius: size / 2
                    });
                }
            }
        }
        
        // 追加の散らばった赤血球
        const extraCount = 20 + waveNum * 3;
        for (let i = 0; i < extraCount; i++) {
            const size = 30 + Math.random() * 50;
            const x = 150 + Math.random() * (WORLD_W - 300);
            const y = 150 + Math.random() * (WORLD_H - 300);
            
            if (Math.hypot(x - WORLD_W/2, y - WORLD_H/2) < 300) continue;
            
            let overlap = false;
            for (const wall of this.walls) {
                if (wall.type === 'cell') {
                    if (Math.hypot(x - wall.cx, y - wall.cy) < wall.radius + size/2 + 20) {
                        overlap = true; break;
                    }
                }
            }
            if (overlap) continue;
            
            this.walls.push({
                x: x - size/2, y: y - size/2, w: size, h: size,
                type: 'cell', cx: x, cy: y, radius: size / 2
            });
        }
    }
    
    checkWall(x, y) {
        for (const w of this.walls) {
            if (w.type === 'cell') {
                if (Math.hypot(x - w.cx, y - w.cy) < w.radius) return true;
            } else {
                if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true;
            }
        }
        return false;
    }
    
    getWallNormal(x, y) {
        for (const w of this.walls) {
            if (w.type === 'cell') {
                const dist = Math.hypot(x - w.cx, y - w.cy);
                if (dist < w.radius + 10) {
                    return { x: (x - w.cx) / dist, y: (y - w.cy) / dist };
                }
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
                    entity.x = testX;
                    entity.y = testY;
                    return true;
                }
            }
        }
        return false;
    }
    
    addPlayer(socket, name) {
        const player = {
            id: socket.id,
            name: name || 'Player',
            x: WORLD_W / 2 + (Math.random() - 0.5) * 200,
            y: WORLD_H / 2 + (Math.random() - 0.5) * 200,
            angle: 0,
            hp: 100,
            maxHp: 100,
            speed: 6,
            invincible: 60,
            dashing: false,
            dashTimer: 0,
            weaponLevels: { PLAZMER: 1, HOMING: 0, LASER: 0, THUNDER: 0, ALLRANGE: 0 },
            thunderEnergy: 0,
            options: [],
            formation: 0,
            score: 0,
            alive: true,
            lastInput: { x: 0, y: 0, angle: 0, dash: false }
        };
        
        this.players.set(socket.id, player);
        
        return player;
    }
    
    removePlayer(socketId) {
        this.players.delete(socketId);
        
        // 全員離脱でルーム削除
        if (this.players.size === 0) {
            rooms.delete(this.id);
        }
    }
    
    startGame() {
        if (this.state !== 'waiting') return;
        
        this.state = 'playing';
        this.wave = 0;
        this.score = 0;
        this.frame = 0;
        this.waveTimer = 0;
        this.enemies = [];
        this.enemyBullets = [];
        this.items = [];
        this.generateWalls(0);
        
        io.to(this.id).emit('gameStart', { wave: this.wave });
    }
    
    startWave() {
        this.wave++;
        this.generateWalls(this.wave);
        
        // プレイヤーが壁に埋まっていたら脱出
        this.players.forEach(player => {
            if (player.alive && this.checkWall(player.x, player.y)) {
                this.escapeFromWall(player);
            }
        });
        
        io.to(this.id).emit('waveStart', { 
            wave: this.wave, 
            walls: this.walls 
        });
        
        // ボス数決定
        let bossCount = 1;
        if (this.wave >= 50) bossCount = 3;
        else if (this.wave >= 20) bossCount = 2;
        if (this.wave % 10 === 0) bossCount += 1;
        
        // マルチプレイ用にボスHP増加
        const playerCount = this.players.size;
        const multiplayerScale = 1 + (playerCount - 1) * 0.5;
        
        setTimeout(() => {
            for (let i = 0; i < bossCount; i++) {
                this.spawnBoss(multiplayerScale);
            }
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
            type: 'boss',
            bossType: bossIndex,
            pattern: template.pattern,
            name: template.name,
            x: pos.x, y: pos.y,
            hp: Math.floor(template.baseHp * waveScale * multiplayerScale * 1.5),
            maxHp: Math.floor(template.baseHp * waveScale * multiplayerScale * 1.5),
            speed: 1.5,
            size: template.size + Math.floor(this.wave / 5) * 2,
            color: template.color,
            score: 3000 + this.wave * 500,
            isBoss: true,
            timer: 0,
            attackTimer: 0,
            phase: 0
        };
        
        this.enemies.push(boss);
        this.currentBosses.push(boss);
        
        io.to(this.id).emit('bossSpawn', { 
            boss: this.sanitizeEnemy(boss),
            bossCount: this.currentBosses.filter(b => b.hp > 0).length
        });
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
            type,
            x, y,
            hp: Math.floor(template.hp * waveScale),
            maxHp: Math.floor(template.hp * waveScale),
            speed: Math.min(template.speed * 2.5 * speedMult, (template.speed + this.wave * 0.05) * speedMult),
            size: template.size,
            color: template.color,
            score: template.score,
            shoots: template.shoots || false,
            armor: template.armor || false,
            divides: template.divides || false,
            isBoss: false,
            timer: Math.floor(Math.random() * 60),
            phase: Math.random() * Math.PI * 2
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
                if (player.alive && Math.hypot(player.x - x, player.y - y) < minDist) {
                    tooClose = true;
                }
            });
            if (tooClose) continue;
            
            return { x, y };
        }
        return { x: WORLD_W - 300, y: WORLD_H - 300 };
    }
    
    update() {
        if (this.state !== 'playing') return;
        
        this.frame++;
        this.waveTimer++;
        this.mobTimer++;
        
        // Wave開始
        if (this.wave === 0 && this.waveTimer > 60) {
            this.startWave();
        }
        
        // 雑魚敵スポーン
        if (this.mobTimer >= 60) {
            this.mobTimer = 0;
            this.spawnMobs();
        }
        
        // プレイヤー更新
        this.players.forEach(player => {
            if (!player.alive) return;
            this.updatePlayer(player);
        });
        
        // 敵更新
        this.updateEnemies();
        
        // 敵弾更新
        this.updateEnemyBullets();
        
        // アイテム更新
        this.updateItems();
        
        // ボス全滅チェック
        const activeBosses = this.currentBosses.filter(b => b.hp > 0);
        if (this.currentBosses.length > 0 && activeBosses.length === 0) {
            this.currentBosses = [];
            // 残り雑魚も全滅
            this.enemies.forEach(e => {
                if (!e.isBoss && e.hp > 0) {
                    e.hp = 0;
                    this.score += 50;
                }
            });
            
            io.to(this.id).emit('bossDefeated', { wave: this.wave, score: this.score });
            
            setTimeout(() => {
                if (this.state === 'playing') this.startWave();
            }, 3000);
        }
        
        // ゲームオーバーチェック
        const alivePlayers = Array.from(this.players.values()).filter(p => p.alive);
        if (alivePlayers.length === 0 && this.players.size > 0) {
            this.state = 'gameover';
            io.to(this.id).emit('gameOver', { score: this.score, wave: this.wave });
        }
        
        // 状態送信
        this.broadcastState();
    }
    
    updatePlayer(player) {
        if (player.invincible > 0) player.invincible--;
        
        // 壁脱出
        if (this.checkWall(player.x, player.y) && !player.dashing) {
            this.escapeFromWall(player);
        }
        
        // ダッシュ処理
        if (player.dashing) {
            player.dashTimer--;
            const vx = Math.cos(player.angle) * 28;
            const vy = Math.sin(player.angle) * 28;
            player.x += vx;
            player.y += vy;
            player.x = Math.max(60, Math.min(WORLD_W - 60, player.x));
            player.y = Math.max(60, Math.min(WORLD_H - 60, player.y));
            if (player.dashTimer <= 0) player.dashing = false;
        } else {
            // 入力による移動
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
        
        // サンダーエネルギー
        if (player.weaponLevels.THUNDER > 0) {
            player.thunderEnergy++;
        }
        
        // 敵との衝突
        this.enemies.forEach(enemy => {
            if (enemy.hp <= 0) return;
            if (Math.hypot(player.x - enemy.x, player.y - enemy.y) < 8 + enemy.size) {
                if (!player.dashing && player.invincible <= 0) {
                    this.damagePlayer(player, enemy.isBoss ? 20 : 10);
                }
            }
        });
    }
    
    updateEnemies() {
        // 最も近いプレイヤーを探す関数
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
            
            if (this.checkWall(enemy.x, enemy.y)) {
                this.escapeFromWall(enemy);
            }
            
            const target = findNearestPlayer(enemy.x, enemy.y);
            if (target) {
                const angle = Math.atan2(target.y - enemy.y, target.x - enemy.x);
                const vx = Math.cos(angle) * enemy.speed;
                const vy = Math.sin(angle) * enemy.speed;
                
                if (!this.checkWall(enemy.x + vx, enemy.y + vy)) {
                    enemy.x += vx;
                    enemy.y += vy;
                } else {
                    if (!this.checkWall(enemy.x + vx, enemy.y)) enemy.x += vx;
                    else if (!this.checkWall(enemy.x, enemy.y + vy)) enemy.y += vy;
                }
                
                // 射撃する敵
                if (enemy.shoots && enemy.timer % 90 === 0) {
                    const a = Math.atan2(target.y - enemy.y, target.x - enemy.x);
                    this.enemyBullets.push({
                        id: 'eb_' + this.enemyIdCounter++,
                        x: enemy.x, y: enemy.y,
                        vx: Math.cos(a) * 5, vy: Math.sin(a) * 5,
                        life: 120, size: 5, color: enemy.color
                    });
                }
                
                // ボス攻撃
                if (enemy.isBoss) {
                    enemy.attackTimer++;
                    this.bossAttack(enemy, target);
                }
            }
        });
        
        // 死んだ敵を除去
        this.enemies = this.enemies.filter(e => e.hp > 0);
    }
    
    bossAttack(boss, target) {
        const angle = Math.atan2(target.y - boss.y, target.x - boss.x);
        
        switch (boss.pattern) {
            case 'radial':
                if (boss.attackTimer % 60 === 0) {
                    for (let i = 0; i < 16; i++) {
                        const a = (Math.PI * 2 / 16) * i + boss.phase;
                        this.enemyBullets.push({
                            id: 'eb_' + this.enemyIdCounter++,
                            x: boss.x, y: boss.y,
                            vx: Math.cos(a) * 4, vy: Math.sin(a) * 4,
                            life: 150, size: 6, color: boss.color
                        });
                    }
                    boss.phase += 0.2;
                }
                break;
            case 'spiral':
                if (boss.attackTimer % 8 === 0) {
                    const a = boss.timer * 0.15;
                    this.enemyBullets.push({
                        id: 'eb_' + this.enemyIdCounter++,
                        x: boss.x, y: boss.y,
                        vx: Math.cos(a) * 5, vy: Math.sin(a) * 5,
                        life: 120, size: 5, color: boss.color
                    });
                }
                break;
            case 'burst':
                if (boss.attackTimer % 40 === 0) {
                    for (let i = 0; i < 8; i++) {
                        const a = angle + (Math.random() - 0.5) * 0.8;
                        const speed = 4 + Math.random() * 3;
                        this.enemyBullets.push({
                            id: 'eb_' + this.enemyIdCounter++,
                            x: boss.x, y: boss.y,
                            vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
                            life: 60, size: 8, color: '#f80'
                        });
                    }
                }
                break;
            case 'swarm':
                if (boss.attackTimer % 5 === 0) {
                    const a = angle + (Math.random() - 0.5) * 1.5;
                    this.enemyBullets.push({
                        id: 'eb_' + this.enemyIdCounter++,
                        x: boss.x, y: boss.y,
                        vx: Math.cos(a) * 6, vy: Math.sin(a) * 6,
                        life: 80, size: 4, color: boss.color
                    });
                }
                break;
            default:
                // その他のパターン
                if (boss.attackTimer % 30 === 0) {
                    for (let i = 0; i < 12; i++) {
                        const a = (Math.PI * 2 / 12) * i + boss.phase;
                        this.enemyBullets.push({
                            id: 'eb_' + this.enemyIdCounter++,
                            x: boss.x, y: boss.y,
                            vx: Math.cos(a) * 5, vy: Math.sin(a) * 5,
                            life: 120, size: 6, color: boss.color
                        });
                    }
                    boss.phase += 0.15;
                }
                break;
        }
    }
    
    updateEnemyBullets() {
        this.enemyBullets.forEach(b => {
            b.x += b.vx;
            b.y += b.vy;
            b.life--;
            
            if (b.life <= 0 || this.checkWall(b.x, b.y)) {
                b.dead = true;
                return;
            }
            
            // プレイヤーとの衝突
            this.players.forEach(player => {
                if (!player.alive || player.invincible > 0 || player.dashing) return;
                if (Math.hypot(player.x - b.x, player.y - b.y) < 8 + b.size) {
                    this.damagePlayer(player, 8);
                    b.dead = true;
                }
            });
        });
        
        this.enemyBullets = this.enemyBullets.filter(b => !b.dead);
    }
    
    updateItems() {
        this.items.forEach(item => {
            this.players.forEach(player => {
                if (!player.alive) return;
                
                // アイテム吸引
                if (Math.hypot(player.x - item.x, player.y - item.y) < 150) {
                    item.x += (player.x - item.x) * 0.1;
                    item.y += (player.y - item.y) * 0.1;
                }
                
                // アイテム取得
                if (Math.hypot(player.x - item.x, player.y - item.y) < 20) {
                    this.collectItem(player, item);
                    item.collected = true;
                }
            });
        });
        
        this.items = this.items.filter(i => !i.collected);
    }
    
    collectItem(player, item) {
        if (item.type === 'H') {
            player.hp = Math.min(player.maxHp, player.hp + 30);
        } else if (item.type === 'ALLRANGE') {
            if (player.options.length < 6) {
                player.options.push({ x: player.x, y: player.y, angle: 0 });
            }
            player.weaponLevels.ALLRANGE++;
        } else {
            player.weaponLevels[item.type] = (player.weaponLevels[item.type] || 0) + 1;
        }
        
        io.to(player.id).emit('itemCollected', { 
            type: item.type, 
            weaponLevels: player.weaponLevels,
            hp: player.hp,
            options: player.options.length
        });
    }
    
    damagePlayer(player, damage) {
        if (player.invincible > 0 || player.dashing) return;
        
        player.hp -= damage;
        player.invincible = 30;
        
        io.to(player.id).emit('playerDamaged', { hp: player.hp, damage });
        
        if (player.hp <= 0) {
            player.alive = false;
            io.to(this.id).emit('playerDied', { playerId: player.id, name: player.name });
        }
    }
    
    damageEnemy(enemyId, damage, weaponType, attackerId) {
        const enemy = this.enemies.find(e => e.id === enemyId);
        if (!enemy || enemy.hp <= 0) return;
        
        if (enemy.armor && weaponType !== 'THUNDER' && weaponType !== 'LASER') {
            damage = Math.floor(damage / 2);
        }
        
        enemy.hp -= damage;
        
        if (enemy.hp <= 0) {
            this.defeatEnemy(enemy, attackerId);
        }
        
        return enemy.hp;
    }
    
    defeatEnemy(enemy, attackerId) {
        const attacker = this.players.get(attackerId);
        if (attacker) {
            attacker.score += enemy.score;
        }
        this.score += enemy.score;
        
        // アイテムドロップ
        this.dropItems(enemy.x, enemy.y, enemy.isBoss);
        
        // 分裂する敵
        if (enemy.divides && !enemy.isBoss) {
            for (let i = 0; i < 2; i++) {
                const a = Math.random() * Math.PI * 2;
                this.spawnEnemy('virus', enemy.x + Math.cos(a) * 30, enemy.y + Math.sin(a) * 30);
            }
        }
        
        io.to(this.id).emit('enemyDefeated', { 
            enemyId: enemy.id, 
            isBoss: enemy.isBoss,
            score: this.score 
        });
    }
    
    dropItems(x, y, isBoss) {
        const itemColors = { PLAZMER: '#fff', HOMING: '#a0f', LASER: '#0ff', THUNDER: '#ff0', ALLRANGE: '#0f0', H: '#f06' };
        
        if (isBoss) {
            const count = 5 + Math.floor(Math.random() * 3);
            const types = ['PLAZMER', 'HOMING', 'LASER', 'THUNDER', 'ALLRANGE', 'H'];
            for (let i = 0; i < count; i++) {
                const a = (Math.PI * 2 / count) * i;
                const type = types[Math.floor(Math.random() * types.length)];
                this.items.push({
                    id: 'item_' + this.enemyIdCounter++,
                    x: x + Math.cos(a) * 60,
                    y: y + Math.sin(a) * 60,
                    type,
                    color: itemColors[type]
                });
            }
        } else {
            if (Math.random() < 0.10) {
                const types = ['PLAZMER', 'HOMING', 'LASER', 'THUNDER'];
                const type = types[Math.floor(Math.random() * types.length)];
                this.items.push({
                    id: 'item_' + this.enemyIdCounter++,
                    x, y, type, color: itemColors[type]
                });
            }
            if (Math.random() < 0.04) {
                this.items.push({
                    id: 'item_' + this.enemyIdCounter++,
                    x, y, type: 'H', color: '#f06'
                });
            }
            if (Math.random() < 0.03) {
                this.items.push({
                    id: 'item_' + this.enemyIdCounter++,
                    x, y, type: 'ALLRANGE', color: '#0f0'
                });
            }
        }
    }
    
    handlePlayerInput(socketId, input) {
        const player = this.players.get(socketId);
        if (!player || !player.alive) return;
        
        player.lastInput = input;
        
        if (input.dash && !player.dashing) {
            player.dashing = true;
            player.dashTimer = 10;
            player.invincible = Math.max(player.invincible, 12);
        }
    }
    
    handlePlayerShoot(socketId, data) {
        const player = this.players.get(socketId);
        if (!player || !player.alive) return;
        
        // クライアントが計算した弾/ミサイルのダメージを検証して敵に適用
        if (data.hits && data.hits.length > 0) {
            data.hits.forEach(hit => {
                this.damageEnemy(hit.enemyId, hit.damage, hit.weaponType, socketId);
            });
        }
    }
    
    sanitizePlayer(player) {
        return {
            id: player.id,
            name: player.name,
            x: player.x,
            y: player.y,
            angle: player.angle,
            hp: player.hp,
            maxHp: player.maxHp,
            invincible: player.invincible,
            dashing: player.dashing,
            alive: player.alive,
            weaponLevels: player.weaponLevels,
            thunderEnergy: player.thunderEnergy,
            options: player.options,
            formation: player.formation,
            score: player.score
        };
    }
    
    sanitizeEnemy(enemy) {
        return {
            id: enemy.id,
            type: enemy.type,
            x: enemy.x,
            y: enemy.y,
            hp: enemy.hp,
            maxHp: enemy.maxHp,
            size: enemy.size,
            color: enemy.color,
            isBoss: enemy.isBoss,
            name: enemy.name,
            pattern: enemy.pattern
        };
    }
    
    broadcastState() {
        const state = {
            frame: this.frame,
            wave: this.wave,
            score: this.score,
            players: Array.from(this.players.values()).map(p => this.sanitizePlayer(p)),
            enemies: this.enemies.map(e => this.sanitizeEnemy(e)),
            enemyBullets: this.enemyBullets.map(b => ({
                id: b.id, x: b.x, y: b.y, size: b.size, color: b.color
            })),
            items: this.items,
            bossCount: this.currentBosses.filter(b => b.hp > 0).length
        };
        
        io.to(this.id).emit('gameState', state);
    }
}

// ========== ルームコード生成 ==========
function generateRoomCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms.has(code));
    return code;
}

// ========== Socket.io 接続処理 ==========
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    let currentRoom = null;
    
    // ホストとしてルーム作成
    socket.on('hostRoom', (data) => {
        const playerName = data.name || 'Host';
        const roomId = generateRoomCode();
        
        // 新しいルームを作成
        const room = new GameRoom(roomId);
        rooms.set(roomId, room);
        
        currentRoom = room;
        socket.join(roomId);
        
        const player = currentRoom.addPlayer(socket, playerName);
        
        socket.emit('hosted', {
            playerId: socket.id,
            roomId: roomId,
            player: currentRoom.sanitizePlayer(player),
            walls: currentRoom.walls,
            state: currentRoom.state,
            wave: currentRoom.wave,
            players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p))
        });
        
        console.log(`Player ${playerName} hosted room ${roomId}`);
    });
    
    // 既存ルームに参加
    socket.on('joinRoom', (data) => {
        const roomId = data.roomId;
        const playerName = data.name || 'Player';
        
        // ルームが存在するかチェック
        if (!rooms.has(roomId)) {
            socket.emit('joinError', { message: `Room ${roomId} not found!` });
            return;
        }
        
        currentRoom = rooms.get(roomId);
        socket.join(roomId);
        
        const player = currentRoom.addPlayer(socket, playerName);
        
        socket.emit('joined', {
            playerId: socket.id,
            roomId: roomId,
            player: currentRoom.sanitizePlayer(player),
            walls: currentRoom.walls,
            state: currentRoom.state,
            wave: currentRoom.wave,
            players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p))
        });
        
        // 他のプレイヤーに通知（プレイヤー数も含む）
        socket.to(roomId).emit('playerJoined', {
            player: currentRoom.sanitizePlayer(player),
            playerCount: currentRoom.players.size
        });
        
        console.log(`Player ${playerName} joined room ${roomId}`);
    });
    
    // ソロプレイ
    socket.on('soloPlay', (data) => {
        const playerName = data.name || 'Solo';
        const roomId = 'solo_' + socket.id;
        
        const room = new GameRoom(roomId);
        room.isSolo = true;
        rooms.set(roomId, room);
        
        currentRoom = room;
        socket.join(roomId);
        
        const player = currentRoom.addPlayer(socket, playerName);
        
        // ソロモードは即座にゲーム開始
        currentRoom.startGame();
        
        socket.emit('joined', {
            playerId: socket.id,
            roomId: roomId,
            player: currentRoom.sanitizePlayer(player),
            walls: currentRoom.walls,
            state: currentRoom.state,
            wave: currentRoom.wave,
            players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p)),
            isSolo: true
        });
        
        console.log(`Player ${playerName} started solo game`);
    });
    
    // ホストがゲーム開始
    socket.on('startGame', () => {
        if (currentRoom && currentRoom.state === 'waiting') {
            currentRoom.startGame();
            io.to(currentRoom.id).emit('gameStarted');
            console.log(`Game started in room ${currentRoom.id}`);
        }
    });
    
    // ホストがキャンセル
    socket.on('cancelHost', () => {
        if (currentRoom) {
            io.to(currentRoom.id).emit('hostCancelled');
            rooms.delete(currentRoom.id);
            currentRoom = null;
        }
    });
    
    socket.on('input', (input) => {
        if (currentRoom) {
            currentRoom.handlePlayerInput(socket.id, input);
        }
    });
    
    socket.on('shoot', (data) => {
        if (currentRoom) {
            currentRoom.handlePlayerShoot(socket.id, data);
        }
    });
    
    socket.on('formation', (data) => {
        if (currentRoom) {
            const player = currentRoom.players.get(socket.id);
            if (player) {
                player.formation = data.formation;
            }
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        if (currentRoom) {
            currentRoom.removePlayer(socket.id);
            socket.to(currentRoom.id).emit('playerLeft', { playerId: socket.id });
        }
    });
});

// ========== ゲームループ ==========
setInterval(() => {
    rooms.forEach(room => {
        room.update();
    });
}, TICK_INTERVAL);

// ========== サーバー起動 ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`PLAZMERS Server running on port ${PORT}`);
});
