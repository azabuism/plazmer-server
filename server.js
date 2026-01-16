const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
// uuidv4は未使用のため削除

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { 
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.static('public'));

// ========== 定数 ==========
const WORLD_W = 3000, WORLD_H = 3000;
const TICK_RATE = 60;
const TICK_INTERVAL = 1000 / TICK_RATE;
const MAX_ENEMY_BULLETS = 200; // 敵弾上限（500→200に削減）
const MAX_ENEMIES = 100;       // 敵数上限
const MAX_ITEMS = 50;          // アイテム上限

// 武器レベルのデフォルト値（クライアントと同期）
const DEFAULT_WEAPON_LEVELS = {
    PLAZMER: 1, HOMING: 0, LASER: 0, THUNDER: 0,
    PHALANX: 1, INTERCEPT: 0, REFLECT: 0, RIFT: 0,
    ANCHOR: 0, DASH: 1, PIERCE: 1, OVERLOAD: 0  // PIERCE: 0→1 初期武器に
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
    { name: 'VIRUS-α', color: '#0f0', baseHp: 100, size: 50, pattern: 'radial', speed: 1.5 },  // HP200→100, 速度低下
    { name: 'BACTERIA-β', color: '#08f', baseHp: 200, size: 55, pattern: 'spiral', speed: 2 }, // HP400→200
    { name: 'INFECTION-γ', color: '#f80', baseHp: 350, size: 60, pattern: 'burst', speed: 2.5 }, // HP600→350
    { name: 'CANCER-δ', color: '#f00', baseHp: 500, size: 70, pattern: 'divide', speed: 2 },  // HP900→500
    { name: 'PLAGUE-ε', color: '#f0f', baseHp: 700, size: 75, pattern: 'swarm', speed: 3 },   // HP1200→700
    { name: 'NECROSIS-ζ', color: '#888', baseHp: 1000, size: 80, pattern: 'laser', speed: 2 }, // HP1600→1000
    { name: 'PANDEMIC-η', color: '#ff0', baseHp: 1400, size: 85, pattern: 'chaos', speed: 3.5 }, // HP2000→1400
    { name: 'NIGHTMARE-θ', color: '#f44', baseHp: 1800, size: 90, pattern: 'nightmare', speed: 3 }, // HP2500→1800
    { name: 'APOCALYPSE-ι', color: '#a0f', baseHp: 2200, size: 95, pattern: 'apocalypse', speed: 3 }, // HP3000→2200
    { name: 'OMEGA-CELL', color: '#fff', baseHp: 3000, size: 120, pattern: 'all', speed: 3.5 } // HP4000→3000
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
        this.bossSpawnPending = null; // ボス出現待ち状態
        this.lastUpdate = Date.now();
        
        this.generateWalls(0);
    }
    
    // 安全な弾追加（上限チェック付き）
    addBullet(bullet) {
        if (this.enemyBullets.length >= MAX_ENEMY_BULLETS) return false;
        this.enemyBullets.push(bullet);
        return true;
    }
    
    // 複数弾追加（上限チェック付き）
    addBullets(bullets) {
        const remaining = MAX_ENEMY_BULLETS - this.enemyBullets.length;
        if (remaining <= 0) return 0;
        const toAdd = bullets.slice(0, remaining);
        this.enemyBullets.push(...toAdd);
        return toAdd.length;
    }
    
    // デバッグログ（1秒ごと）
    logStatus() {
        if (this.frame % 60 === 0 && this.state === 'playing') {
            console.log(`[Room ${this.id}] frame:${this.frame} enemies:${this.enemies.length} alive:${this.enemies.filter(e => e && e.hp > 0).length} bullets:${this.enemyBullets.length} items:${this.items.length}`);
        }
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
    
    addPlayer(socket, name, isHost = false, character = 'EIRYKLAV') {
        const playerIndex = this.players.size;
        const colorData = PLAYER_COLORS[Math.min(playerIndex, PLAYER_COLORS.length - 1)];
        
        // Ver.1.0037: キャラクターごとの初期設定
        // Ver.1.0037: キャラクター2体制（NAGAL削除）
        const charStats = {
            EIRYKLAV: { hp: 200, speed: 4.0, main: 'PLAZMER', sub: 'MISSILE' }, // 主人公機・飛行機
            AGOREKIK: { hp: 280, speed: 3.0, main: 'BIO_PHALANX', sub: 'DEVOUR' } // 捕食キャラ
        };
        const stats = charStats[character] || charStats.EIRYKLAV;
        
        const player = {
            id: socket.id,
            name: name || 'Player',
            character: character,
            x: WORLD_W / 2 + (Math.random() - 0.5) * 200,
            y: WORLD_H / 2 + (Math.random() - 0.5) * 200,
            angle: 0,
            hp: stats.hp,
            maxHp: stats.hp,
            speed: stats.speed,
            invincible: 60,
            dashing: false,
            dashTimer: 0,
            // Ver.1.0037: キャラ固定武器（シンプル化）
            weaponLevels: { 
                // EIRYKLAV用
                PLAZMER: character === 'EIRYKLAV' ? 1 : 0,
                LASER: character === 'EIRYKLAV' ? 1 : 0,
                MISSILE: character === 'EIRYKLAV' ? 1 : 0,
                // AGOREKIK用
                BIO_PHALANX: character === 'AGOREKIK' ? 1 : 0,
                DEVOUR: character === 'AGOREKIK' ? 1 : 0,
                // 共通
                DASH: 1
            },
            equipped: { 
                main: stats.main,
                sub: stats.sub,
                activeWeapon: stats.main
            },
            // AGOREKIK用：触手（4本から開始）
            tentacles: character === 'AGOREKIK' ? [
                { angle: 0, length: 60 },
                { angle: Math.PI / 2, length: 60 },
                { angle: Math.PI, length: 60 },
                { angle: Math.PI * 1.5, length: 60 }
            ] : [],
            tentacleMode: 'defense', // defense/attack フォーメーション
            // AGOREKIK用：捕食システム
            devourCooldown: 0,
            devourBuff: 0, // 捕食バフ残り時間
            score: 0,
            alive: true,
            lastInput: { x: 0, y: 0, angle: 0, dash: false },
            isHost: isHost,
            playerIndex: playerIndex,
            color: colorData.main,
            glowColor: colorData.glow,
            colorName: colorData.name,
            ready: isHost,
            respawnTimer: 0
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
        
        // 重要: 前のWAVEのボスをクリア
        this.currentBosses = [];
        this.enemies = this.enemies.filter(e => e.isBoss === false); // 残った雑魚もクリア
        
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
        
        // ボス出現条件：雑魚を一定数倒してから
        this.bossSpawnPending = {
            count: bossCount,
            scale: multiplayerScale,
            killsRequired: 5 + Math.floor(this.wave * 0.5), // Wave1: 5匹, Wave10: 10匹
            killsCount: 0,
            spawned: false
        };
        
        console.log(`Wave ${this.wave}: Boss spawns after ${this.bossSpawnPending.killsRequired} kills`);
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
            attackTimer: 1,  // 0だと即攻撃してしまうので1から開始
            phase: 0,
            spawnDelay: 120   // 2秒間は攻撃しない
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
        // ボス出現前でも雑魚はスポーンする
        // ボス出現後は雑魚スポーンを継続
        
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
        // 完全停止はwaitingのみ
        if (this.state === 'waiting') return;
        
        this.frame++;
        
        // デバッグログ（5秒ごと）
        this.logStatus();
        
        // 上限チェック（安全装置）
        if (this.enemies.length > MAX_ENEMIES) {
            this.enemies = this.enemies.slice(-MAX_ENEMIES);
        }
        if (this.enemyBullets.length > MAX_ENEMY_BULLETS) {
            this.enemyBullets = this.enemyBullets.slice(-MAX_ENEMY_BULLETS);
        }
        if (this.items.length > MAX_ITEMS) {
            this.items = this.items.slice(-MAX_ITEMS);
        }
        
        // weaponSelect中でも最低限更新するもの
        this.players.forEach(player => {
            // invincible / overload.timer は常に更新
            if (player.invincible > 0) player.invincible--;
            if (player.overload && player.overload.active) {
                player.overload.timer--;
                if (player.overload.timer <= 0) {
                    player.overload.active = false;
                }
            }
            // リスポーンタイマー
            if (!player.alive && player.respawnTimer !== undefined) {
                player.respawnTimer++;
                if (player.respawnTimer >= 180) { // 5秒→3秒に短縮
                    this.respawnPlayer(player);
                }
            }
        });
        
        // weaponSelect中はここで終了
        if (this.state === 'weaponSelect') {
            this.broadcastState();
            return;
        }
        
        // playing中のみ実行
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
        
        // プレイヤー更新（alive状態）
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
        
        // ボス全滅チェック（ボスがスポーンされるまでスキップ）
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
            
            // 武器選択を自動スキップして次のWAVEへ
            setTimeout(() => {
                if (this.state === 'playing') {
                    // 次のWAVEを開始
                    this.startWave();
                    io.to(this.id).emit('waveStarting');
                    console.log(`Room ${this.id}: Auto-starting Wave ${this.wave}`);
                }
            }, 3000);
        }
        
        // 状態送信（30fps - 安定性重視）
        if (this.frame % 2 === 0) {
            this.broadcastState();
        }
    }
    
    updatePlayer(player) {
        // リスポーン処理
        if (!player.alive) {
            player.respawnTimer++;
            if (player.respawnTimer >= 300) { // 5秒でリスポーン
                this.respawnPlayer(player);
            }
            return;
        }
        
        // ========== キャラクター固有の更新処理 ==========
        
        // AGOREKIK: 触手集中タイマー
        if (player.character === 'AGOREKIK' && player.tentacleConcentrate) {
            if (player.tentacleConcentrate.active) {
                player.tentacleConcentrate.timer--;
                if (player.tentacleConcentrate.timer <= 0) {
                    player.tentacleConcentrate.active = false;
                }
            }
        }
        
        // AGOREKIK: 自動捕食システム
        if (player.character === 'AGOREKIK') {
            // 捕食クールダウン減少
            if (player.devourCooldown > 0) player.devourCooldown--;
            if (player.devourBuff > 0) player.devourBuff--;
            
            // 近くの敵を自動捕食
            if (player.devourCooldown <= 0) {
                for (const enemy of this.enemies) {
                    if (!enemy || enemy.hp <= 0 || enemy.isZombie) continue;
                    
                    const dist = Math.hypot(enemy.x - player.x, enemy.y - player.y);
                    const devourRange = 40 + (player.weaponLevels.DEVOUR || 1) * 5;
                    
                    if (dist < devourRange) {
                        // ボスは捕食不可だが噛みつきダメージ
                        if (enemy.isBoss) {
                            enemy.hp -= 15; // 噛みつきダメージ
                            io.to(this.id).emit('devourBite', {
                                playerId: player.id,
                                enemyId: enemy.id,
                                x: enemy.x, y: enemy.y
                            });
                            player.devourCooldown = 30; // 0.5秒クールダウン
                        } else {
                            // 小型・中型は捕食可能（HPが30%以下か小型）
                            const isSmall = enemy.size <= 15;
                            const isWeak = enemy.hp <= enemy.maxHp * 0.3;
                            
                            if (isSmall || isWeak) {
                                // 捕食成功！
                                const healAmount = Math.min(20, enemy.maxHp * 0.2);
                                player.hp = Math.min(player.maxHp, player.hp + healAmount);
                                player.devourBuff = 180; // 3秒間攻撃バフ
                                player.score += enemy.score * 2; // スコアボーナス
                                
                                io.to(this.id).emit('devourSuccess', {
                                    playerId: player.id,
                                    enemyId: enemy.id,
                                    x: enemy.x, y: enemy.y,
                                    heal: healAmount
                                });
                                
                                enemy.hp = 0;
                                this.defeatEnemy(enemy, player.id);
                                player.devourCooldown = 20; // 捕食後クールダウン
                                break;
                            }
                        }
                    }
                }
            }
            
            // 捕食バフ中は移動速度低下なし、攻撃力アップ
        }
        
        // EIRYKLAV: ミサイル自動発射
        if (player.character === 'EIRYKLAV' && player.alive) {
            if (this.frame % 90 === 0) { // 1.5秒ごと
                // 最も近い敵にミサイル発射
                let target = null, minDist = 400;
                this.enemies.forEach(e => {
                    if (!e || e.hp <= 0) return;
                    const d = Math.hypot(e.x - player.x, e.y - player.y);
                    if (d < minDist) { minDist = d; target = e; }
                });
                
                if (target) {
                    io.to(this.id).emit('autoMissile', {
                        playerId: player.id,
                        targetId: target.id,
                        x: player.x, y: player.y,
                        targetX: target.x, targetY: target.y
                    });
                }
            }
        }
        
        // invincibleとoverloadはupdate()で既に更新済み
        
        // 壁脱出
        if (this.checkWall(player.x, player.y)) {
            this.escapeFromWall(player);
        }
        
        // 移動処理（マリオBダッシュ方式）
        const input = player.lastInput;
        if (input.moving) {
            // ダッシュ中は速度2倍
            const speedMultiplier = input.dashing ? 2.0 : 1.0;
            const moveSpeed = player.speed * speedMultiplier;
            
            const vx = Math.cos(input.angle) * moveSpeed;
            const vy = Math.sin(input.angle) * moveSpeed;
            
            if (!this.checkWall(player.x + vx, player.y)) player.x += vx;
            if (!this.checkWall(player.x, player.y + vy)) player.y += vy;
            
            player.angle = input.angle;
        }
        
        // ダッシュ中のエフェクト用フラグ
        player.dashing = input.dashing || false;
        
        player.x = Math.max(60, Math.min(WORLD_W - 60, player.x));
        player.y = Math.max(60, Math.min(WORLD_H - 60, player.y));
        
        // 敵との衝突
        this.enemies.forEach(enemy => {
            if (!enemy || enemy.hp <= 0) return;
            if (Math.hypot(player.x - enemy.x, player.y - enemy.y) < 8 + enemy.size) {
                if (player.invincible <= 0) {
                    this.damagePlayer(player, enemy.isBoss ? 15 : 8);
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
        player.invincible = 180; // 3秒無敵
        player.respawnTimer = 0;
        player.dashing = false;
        player.dashTimer = 0;
        
        // 武器レベルを半減（最低1は維持）
        player.weaponLevels.PLAZMER = Math.max(1, Math.floor(player.weaponLevels.PLAZMER / 2));
        player.weaponLevels.HOMING = Math.floor(player.weaponLevels.HOMING / 2);
        player.weaponLevels.LASER = Math.floor(player.weaponLevels.LASER / 2);
        player.weaponLevels.THUNDER = Math.floor(player.weaponLevels.THUNDER / 2);
        player.weaponLevels.PHALANX = Math.floor(player.weaponLevels.PHALANX / 2);
        
        // オプション数も半減
        const newOptionCount = Math.floor(player.options.length / 2);
        player.options = player.options.slice(0, newOptionCount);
        
        io.to(player.id).emit('respawned', {
            x: player.x,
            y: player.y,
            hp: player.hp,
            weaponLevels: player.weaponLevels,
            options: player.options.length
        });
        
        io.to(this.id).emit('playerRespawned', {
            playerId: player.id,
            name: player.name
        });
    }
    
    updateEnemies() {
        // 死んだ敵を先に除去（重要！）
        this.enemies = this.enemies.filter(e => e && e.hp > 0);
        
        // 敵数制限
        if (this.enemies.length > MAX_ENEMIES) {
            this.enemies = this.enemies.slice(0, MAX_ENEMIES);
        }
        
        // 敵がいなければ終了
        if (this.enemies.length === 0) return;
        
        // アクティブなプレイヤーを取得
        const activePlayers = [];
        this.players.forEach(p => {
            if (p.alive) activePlayers.push(p);
        });
        
        // 各敵を更新（シンプルなループ）
        for (let i = 0; i < this.enemies.length; i++) {
            const enemy = this.enemies[i];
            if (!enemy) continue;
            
            enemy.timer = (enemy.timer || 0) + 1;
            
            // 固定状態
            if (enemy.anchored) {
                if (enemy.anchorTimer > 0) enemy.anchorTimer--;
                else enemy.anchored = false;
                continue;
            }
            
            // ターゲットを探す
            let target = null;
            let minDist = Infinity;
            for (const p of activePlayers) {
                const d = Math.hypot(p.x - enemy.x, p.y - enemy.y);
                if (d < minDist) {
                    minDist = d;
                    target = p;
                }
            }
            
            // 移動
            if (target) {
                const angle = Math.atan2(target.y - enemy.y, target.x - enemy.x);
                enemy.x += Math.cos(angle) * (enemy.speed || 2);
                enemy.y += Math.sin(angle) * (enemy.speed || 2);
            } else {
                // ランダム徘徊
                if (!enemy.wanderAngle || enemy.timer % 60 === 0) {
                    enemy.wanderAngle = Math.random() * Math.PI * 2;
                }
                enemy.x += Math.cos(enemy.wanderAngle) * 1;
                enemy.y += Math.sin(enemy.wanderAngle) * 1;
            }
            
            // 境界制限
            enemy.x = Math.max(50, Math.min(WORLD_W - 50, enemy.x));
            enemy.y = Math.max(50, Math.min(WORLD_H - 50, enemy.y));
            
            // ボス攻撃
            if (enemy.isBoss && target) {
                enemy.attackTimer = (enemy.attackTimer || 0) + 1;
                if (enemy.attackTimer > 180) { // 3秒ごと
                    this.bossAttack(enemy, target);
                }
            }
        }
    }
    
    bossAttack(boss, target) {
        try {
            // スポーン直後は攻撃しない
            if (boss.spawnDelay > 0) {
                boss.spawnDelay--;
                return;
            }
            
            // 弾数上限チェック（先に確認）
            if (this.enemyBullets.length >= MAX_ENEMY_BULLETS - 20) return;
            
            // ボスのpatternが未定義の場合は何もしない
            if (!boss.pattern) return;
            
            const angle = Math.atan2(target.y - boss.y, target.x - boss.x);
            
            // Wave別の攻撃間隔倍率（序盤は緩く、後半も緩和）
            const waveMultiplier = Math.max(1.5, 3 - this.wave * 0.08);
            
            switch (boss.pattern) {
                case 'radial':
                    // 放射状弾幕（大幅緩和）
                if (boss.attackTimer % Math.floor(120 * waveMultiplier) === 0) {
                    const bulletCount = Math.min(8, 6 + Math.floor(this.wave / 4));
                    for (let i = 0; i < bulletCount; i++) {
                        const a = (Math.PI * 2 / bulletCount) * i + boss.phase;
                        this.addBullet({
                            id: 'eb_' + this.enemyIdCounter++,
                            x: boss.x, y: boss.y,
                            vx: Math.cos(a) * 3, vy: Math.sin(a) * 3,
                            life: 120, size: 6, color: boss.color
                        });
                    }
                    boss.phase += 0.2;
                }
                break;
            case 'spiral':
                // 螺旋弾（間隔をさらに広げる）
                if (boss.attackTimer % Math.floor(30 * waveMultiplier) === 0) {
                    const a = boss.timer * 0.12;
                    this.addBullet({
                        id: 'eb_' + this.enemyIdCounter++,
                        x: boss.x, y: boss.y,
                        vx: Math.cos(a) * 4, vy: Math.sin(a) * 4,
                        life: 100, size: 5, color: boss.color
                    });
                }
                break;
            case 'burst':
                // バースト弾（弾数を減らす）
                if (boss.attackTimer % Math.floor(90 * waveMultiplier) === 0) {
                    for (let i = 0; i < 3; i++) {
                        const a = angle + (Math.random() - 0.5) * 0.5;
                        const speed = 3 + Math.random() * 2;
                        this.addBullet({
                            id: 'eb_' + this.enemyIdCounter++,
                            x: boss.x, y: boss.y,
                            vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
                            life: 50, size: 8, color: '#f80'
                        });
                    }
                }
                break;
            case 'swarm':
                // 群弾（間隔を広げる）
                if (boss.attackTimer % Math.floor(25 * waveMultiplier) === 0) {
                    const a = angle + (Math.random() - 0.5) * 1.2;
                    this.addBullet({
                        id: 'eb_' + this.enemyIdCounter++,
                        x: boss.x, y: boss.y,
                        vx: Math.cos(a) * 5, vy: Math.sin(a) * 5,
                        life: 60, size: 4, color: boss.color
                    });
                }
                break;
            case 'laser':
                // レーザービーム攻撃（大幅削減）
                if (boss.attackTimer % Math.floor(180 * waveMultiplier) === 0) {
                    // 2方向レーザー（4→2に削減）
                    for (let i = 0; i < 2; i++) {
                        const a = (Math.PI) * i + boss.phase;
                        for (let j = 0; j < 5; j++) { // 10→5に削減
                            this.addBullet({
                                id: 'eb_' + this.enemyIdCounter++,
                                x: boss.x + Math.cos(a) * j * 30,
                                y: boss.y + Math.sin(a) * j * 30,
                                vx: Math.cos(a) * 6, vy: Math.sin(a) * 6,
                                life: 30, size: 4, color: '#f00'
                            });
                        }
                    }
                    boss.phase += 0.4;
                }
                break;
            case 'chaos':
                // カオスパターン（大幅緩和）
                if (boss.attackTimer % Math.floor(60 * waveMultiplier) === 0) {
                    // 螺旋（2発に削減）
                    for (let i = 0; i < 2; i++) {
                        const a = boss.timer * 0.2 + i * Math.PI;
                        this.addBullet({
                            id: 'eb_' + this.enemyIdCounter++,
                            x: boss.x, y: boss.y,
                            vx: Math.cos(a) * 4, vy: Math.sin(a) * 4,
                            life: 120, size: 6, color: '#ff0'
                        });
                    }
                }
                if (boss.attackTimer % Math.floor(150 * waveMultiplier) === 0) {
                    // 放射（8発に削減）
                    for (let i = 0; i < 8; i++) {
                        const a = (Math.PI * 2 / 8) * i;
                        this.addBullet({
                            id: 'eb_' + this.enemyIdCounter++,
                            x: boss.x, y: boss.y,
                            vx: Math.cos(a) * 2.5, vy: Math.sin(a) * 2.5,
                            life: 150, size: 8, color: '#f80'
                        });
                    }
                }
                break;
            case 'nightmare':
                // ナイトメア（大幅緩和）
                if (boss.attackTimer % Math.floor(90 * waveMultiplier) === 0) {
                    // プレイヤー追尾弾（1発のみ）
                    this.addBullet({
                        id: 'eb_' + this.enemyIdCounter++,
                        x: boss.x, y: boss.y,
                        vx: Math.cos(angle) * 4, vy: Math.sin(angle) * 4,
                        life: 80, size: 10, color: '#f44',
                        homing: true, target: target
                    });
                }
                if (boss.attackTimer % Math.floor(50 * waveMultiplier) === 0) {
                    // 回転弾幕（2発に削減）
                    for (let i = 0; i < 2; i++) {
                        const a = boss.timer * 0.08 + i * Math.PI;
                        this.addBullet({
                            id: 'eb_' + this.enemyIdCounter++,
                            x: boss.x, y: boss.y,
                            vx: Math.cos(a) * 3, vy: Math.sin(a) * 3,
                            life: 120, size: 5, color: '#a44'
                        });
                    }
                }
                break;
            case 'apocalypse':
                // アポカリプス（大幅緩和）
                if (boss.attackTimer % Math.floor(45 * waveMultiplier) === 0) {
                    // 螺旋（1発に削減）
                    const a1 = boss.timer * 0.2;
                    this.addBullet({
                        id: 'eb_' + this.enemyIdCounter++,
                        x: boss.x, y: boss.y,
                        vx: Math.cos(a1) * 4, vy: Math.sin(a1) * 4,
                        life: 150, size: 7, color: '#a0f'
                    });
                }
                if (boss.attackTimer % Math.floor(150 * waveMultiplier) === 0) {
                    // 放射（8発に削減）
                    for (let i = 0; i < 8; i++) {
                        const a = (Math.PI * 2 / 8) * i + boss.phase;
                        this.addBullet({
                            id: 'eb_' + this.enemyIdCounter++,
                            x: boss.x, y: boss.y,
                            vx: Math.cos(a) * 3, vy: Math.sin(a) * 3,
                            life: 150, size: 6, color: '#f0f'
                        });
                    }
                    boss.phase += 0.15;
                }
                // 十字レーザーは削除（負荷が高すぎる）
                break;
            case 'all':
                // 全パターン（大幅緩和）
                const phase = Math.floor(boss.attackTimer / 240) % 4; // フェーズを減らす
                if (phase === 0 && boss.attackTimer % Math.floor(50 * waveMultiplier) === 0) {
                    // 螺旋×1
                    const a1 = boss.timer * 0.15;
                    this.addBullet({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a1) * 4, vy: Math.sin(a1) * 4, life: 120, size: 6, color: '#fff' });
                }
                if (phase === 1 && boss.attackTimer % Math.floor(120 * waveMultiplier) === 0) {
                    // 放射（8発に削減）
                    for (let i = 0; i < 8; i++) {
                        const a = (Math.PI * 2 / 8) * i + boss.phase;
                        this.addBullet({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a) * 3, vy: Math.sin(a) * 3, life: 150, size: 8, color: '#ff0' });
                    }
                    boss.phase += 0.2;
                }
                if (phase === 2 && boss.attackTimer % Math.floor(30 * waveMultiplier) === 0) {
                    const a = angle + (Math.random() - 0.5) * 1.5;
                    this.addBullet({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a) * 5, vy: Math.sin(a) * 5, life: 60, size: 5, color: '#f00' });
                }
                if (phase === 3 && boss.attackTimer % Math.floor(60 * waveMultiplier) === 0) {
                    for (let i = 0; i < 4; i++) {
                        const a = (Math.PI * 2 / 4) * i + boss.timer * 0.1;
                        this.addBullet({ id: 'eb_' + this.enemyIdCounter++, x: boss.x, y: boss.y, vx: Math.cos(a) * 4, vy: Math.sin(a) * 4, life: 100, size: 7, color: '#f0f' });
                    }
                }
                break;
        }
        } catch(err) {
            console.error('bossAttack error:', err.message);
        }
    }
    
    updateEnemyBullets() {
        this.enemyBullets.forEach(b => {
            // ゾンビ弾は敵に向かう
            if (b.isZombieBullet) {
                // ゾンビ弾は非ゾンビ敵に当たる
                this.enemies.forEach(enemy => {
                    if (enemy.isZombie || enemy.hp <= 0) return;
                    if (Math.hypot(enemy.x - b.x, enemy.y - b.y) < enemy.size + b.size) {
                        enemy.hp -= 10;
                        b.dead = true;
                        
                        // ゾンビ弾で倒した敵もゾンビ化
                        if (enemy.hp <= 0 && !enemy.isBoss) {
                            enemy.isZombie = true;
                            enemy.zombieOwner = b.zombieOwner;
                            enemy.hp = enemy.maxHp * 0.3;
                        }
                    }
                });
                
                b.x += b.vx;
                b.y += b.vy;
                b.life--;
                
                if (b.life <= 0 || this.checkWall(b.x, b.y)) {
                    b.dead = true;
                }
                return; // ゾンビ弾はプレイヤーに当たらない
            }
            
            // 追尾弾の処理
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
                    b.vx = Math.cos(newAngle) * speed;
                    b.vy = Math.sin(newAngle) * speed;
                }
            }
            
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
                if (Math.hypot(player.x - b.x, player.y - b.y) < 6 + b.size) { // 当たり判定を8→6に縮小
                    this.damagePlayer(player, 5); // 8→5ダメージに軽減
                    b.dead = true;
                }
            });
        });
        
        this.enemyBullets = this.enemyBullets.filter(b => !b.dead);
        
        // 上限を超えた場合、古い弾から削除
        if (this.enemyBullets.length > MAX_ENEMY_BULLETS) {
            this.enemyBullets = this.enemyBullets.slice(-MAX_ENEMY_BULLETS);
        }
    }
    
    updateItems() {
        this.items.forEach(item => {
            // 壁の中のアイテムを自動的に移動
            if (this.checkWall(item.x, item.y)) {
                for (let dist = 20; dist < 200; dist += 20) {
                    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
                        const testX = item.x + Math.cos(a) * dist;
                        const testY = item.y + Math.sin(a) * dist;
                        if (!this.checkWall(testX, testY)) {
                            item.x = testX;
                            item.y = testY;
                            break;
                        }
                    }
                    if (!this.checkWall(item.x, item.y)) break;
                }
            }
            
            this.players.forEach(player => {
                if (!player.alive) return;
                
                // アイテム吸引（さらに範囲拡大・強化）
                const dist = Math.hypot(player.x - item.x, player.y - item.y);
                if (dist < 400) { // 250→400に拡大
                    const pullStrength = 0.15 + (1 - dist / 400) * 0.2; // 距離に応じて吸引力UP
                    item.x += (player.x - item.x) * pullStrength;
                    item.y += (player.y - item.y) * pullStrength;
                }
                
                // アイテム取得（さらに範囲拡大）
                if (dist < 80) { // 50→80に拡大
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
        } else if (item.type === 'PHALANX') {
            if (player.options.length < 6) {
                player.options.push({ x: player.x, y: player.y, angle: 0 });
            }
            player.weaponLevels.PHALANX++;
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
        player.invincible = 90; // 30→90フレーム（1.5秒）に延長
        
        io.to(player.id).emit('playerDamaged', { hp: player.hp, damage });
        
        if (player.hp <= 0) {
            player.alive = false;
            io.to(this.id).emit('playerDied', { playerId: player.id, name: player.name });
        }
    }
    
    damageEnemy(enemyId, damage, weaponType, attackerId) {
        try {
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
        } catch (err) {
            console.error('damageEnemy error:', err.message);
            return 0;
        }
    }
    
    defeatEnemy(enemy, attackerId) {
        try {
            // 敵のHPを0に設定（確実に死亡させる）
            enemy.hp = 0;
            
            const attacker = this.players.get(attackerId);
            if (attacker) {
                attacker.score += enemy.score || 0;
            }
            this.score += enemy.score || 0;
        
        // アイテムドロップ
        this.dropItems(enemy.x, enemy.y, enemy.isBoss);
        
        // 分裂する敵
        if (enemy.divides && !enemy.isBoss) {
            for (let i = 0; i < 2; i++) {
                const a = Math.random() * Math.PI * 2;
                this.spawnEnemy('virus', enemy.x + Math.cos(a) * 30, enemy.y + Math.sin(a) * 30);
            }
        }
        
        // 雑魚撃破でボス出現条件チェック
        if (!enemy.isBoss && this.bossSpawnPending && !this.bossSpawnPending.spawned) {
            this.bossSpawnPending.killsCount++;
            
            if (this.bossSpawnPending.killsCount >= this.bossSpawnPending.killsRequired) {
                this.bossSpawnPending.spawned = true;
                
                // 警告を出してからボス出現
                io.to(this.id).emit('bossWarning', { wave: this.wave });
                
                setTimeout(() => {
                    for (let i = 0; i < this.bossSpawnPending.count; i++) {
                        this.spawnBoss(this.bossSpawnPending.scale);
                    }
                }, 2000); // 2秒後にボス出現
                
                console.log(`Wave ${this.wave}: Boss spawning after ${this.bossSpawnPending.killsCount} kills!`);
            }
        }
        
        io.to(this.id).emit('enemyDefeated', { 
            enemyId: enemy.id, 
            isBoss: enemy.isBoss,
            score: this.score 
        });
        } catch (err) {
            console.error('defeatEnemy error:', err.message);
        }
    }
    
    dropItems(x, y, isBoss) {
        // 武器カラー定義（新仕様）
        const WEAPON_COLORS = {
            PLAZMER:   '#00FFFF',
            PHALANX:   '#00FF66',
            HOMING:    '#AA66FF',
            INTERCEPT: '#66CCFF',
            LASER:     '#00CCFF',
            REFLECT:   '#CCFFFF',
            RIFT:      '#FF44CC',
            ANCHOR:    '#663399',
            THUNDER:   '#FFFF33',
            DASH:      '#FF9933',
            PIERCE:    '#CC3333',
            H:         '#FF6666'
        };
        
        // Wave別解放武器マップ
        const WAVE_UNLOCK = {
            1: ['PLAZMER', 'PHALANX'],
            3: ['HOMING'],
            4: ['INTERCEPT'],
            6: ['LASER'],
            7: ['REFLECT'],
            8: ['RIFT'],
            10: ['ANCHOR'],
            12: ['THUNDER'],
            14: ['DASH'],
            16: ['PIERCE'],
            20: ['OVERLOAD']
        };
        
        // 現在のWaveで解放される武器を取得
        const getUnlockedWeapons = () => {
            const unlocked = [];
            for (let w = 1; w <= this.wave; w++) {
                if (WAVE_UNLOCK[w]) {
                    unlocked.push(...WAVE_UNLOCK[w]);
                }
            }
            return unlocked.filter(w => w !== 'OVERLOAD'); // OVERLOADはドロップしない
        };
        
        // 安全なアイテム位置を見つける関数
        const findSafeItemPos = (baseX, baseY) => {
            if (!this.checkWall(baseX, baseY)) return { x: baseX, y: baseY };
            for (let dist = 20; dist < 150; dist += 20) {
                for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
                    const testX = baseX + Math.cos(a) * dist;
                    const testY = baseY + Math.sin(a) * dist;
                    if (!this.checkWall(testX, testY) && 
                        testX > 60 && testX < WORLD_W - 60 && 
                        testY > 60 && testY < WORLD_H - 60) {
                        return { x: testX, y: testY };
                    }
                }
            }
            return { x: baseX, y: baseY };
        };
        
        if (isBoss) {
            // ボス撃破時：このWaveで解放される武器をドロップ（1個ずつ）
            const newWeapons = WAVE_UNLOCK[this.wave] || [];
            
            // 新武器をドロップ
            newWeapons.forEach((type, i) => {
                if (type === 'OVERLOAD') return; // OVERLOADはドロップしない
                const a = (Math.PI * 2 / Math.max(1, newWeapons.length)) * i;
                const pos = findSafeItemPos(x + Math.cos(a) * 50, y + Math.sin(a) * 50);
                this.items.push({
                    id: 'item_' + this.enemyIdCounter++,
                    x: pos.x, y: pos.y,
                    type: type,
                    color: WEAPON_COLORS[type] || '#fff',
                    isNew: true // 新武器フラグ
                });
            });
            
            // HP回復を1〜2個だけドロップ
            const hpCount = 1 + Math.floor(Math.random() * 2);
            for (let i = 0; i < hpCount; i++) {
                const a = Math.random() * Math.PI * 2;
                const dist = 30 + Math.random() * 50;
                const pos = findSafeItemPos(x + Math.cos(a) * dist, y + Math.sin(a) * dist);
                this.items.push({
                    id: 'item_' + this.enemyIdCounter++,
                    x: pos.x, y: pos.y,
                    type: 'H',
                    color: WEAPON_COLORS.H
                });
            }
            
            // レベルアップアイテムはボスからはドロップしない（雑魚から1個ずつ取得）
        } else {
            // 雑魚撃破時：HP回復中心、たまに武器レベルアップ
            
            // HP回復（確率高め）
            if (Math.random() < 0.20) { // 20%でHP回復
                const pos = findSafeItemPos(x, y);
                this.items.push({
                    id: 'item_' + this.enemyIdCounter++,
                    x: pos.x, y: pos.y,
                    type: 'H',
                    color: WEAPON_COLORS.H
                });
            }
            
            // 解放済み武器のレベルアップ（低確率）
            if (Math.random() < 0.08) {
                const unlockedWeapons = getUnlockedWeapons();
                const type = unlockedWeapons[Math.floor(Math.random() * unlockedWeapons.length)];
                if (type) {
                    const pos = findSafeItemPos(x, y);
                    this.items.push({
                        id: 'item_' + this.enemyIdCounter++,
                        x: pos.x, y: pos.y,
                        type: type,
                        color: WEAPON_COLORS[type] || '#fff'
                    });
                }
            }
        }
    }
    
    handlePlayerInput(socketId, input) {
        const player = this.players.get(socketId);
        if (!player || !player.alive) return;
        
        // 入力を保存（dashingフラグを含む）
        player.lastInput = {
            angle: input.angle || 0,
            moving: input.moving || false,
            dashing: input.dashing || false, // Bダッシュ：押している間true
            x: input.x,
            y: input.y
        };
        
        // クライアントからの位置情報を考慮
        if (input.x !== undefined && input.y !== undefined) {
            const dist = Math.hypot(input.x - player.x, input.y - player.y);
            if (dist < player.speed * 5) { // 許容範囲を広げる
                player.x = input.x;
                player.y = input.y;
            }
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
            character: player.character,
            x: player.x,
            y: player.y,
            angle: player.angle,
            hp: player.hp,
            maxHp: player.maxHp,
            invincible: player.invincible,
            dashing: player.dashing || false,
            alive: player.alive,
            weaponLevels: player.weaponLevels,
            equipped: player.equipped,
            // AGOREKIK用
            tentacles: player.tentacles,
            tentacleMode: player.tentacleMode || 'defense',
            devourBuff: player.devourBuff || 0,
            // 共通
            score: player.score,
            isHost: player.isHost,
            playerIndex: player.playerIndex,
            color: player.color,
            glowColor: player.glowColor,
            colorName: player.colorName,
            ready: player.ready,
            respawnTimer: player.respawnTimer
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
            pattern: enemy.pattern,
            isZombie: enemy.isZombie || false,
            zombieOwner: enemy.zombieOwner || null,
            parasitedBy: enemy.parasitedBy || null
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

// ========== プレイヤー色定義 ==========
const PLAYER_COLORS = [
    { main: '#ffffff', glow: '#0ff', name: 'WHITE' },   // HOST
    { main: '#ff4444', glow: '#f00', name: 'RED' },     // Guest 1
    { main: '#aa44ff', glow: '#a0f', name: 'PURPLE' },  // Guest 2
    { main: '#4488ff', glow: '#08f', name: 'BLUE' }     // Guest 3
];

// ========== Socket.io 接続処理 ==========
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    let currentRoom = null;
    
    // ホストとしてルーム作成
    socket.on('hostRoom', (data) => {
        const playerName = data.name || 'Host';
        const character = data.character || 'NAGAL';
        const roomId = generateRoomCode();
        
        // 新しいルームを作成
        const room = new GameRoom(roomId);
        room.hostId = socket.id;
        rooms.set(roomId, room);
        
        currentRoom = room;
        socket.join(roomId);
        
        const player = currentRoom.addPlayer(socket, playerName, true, character); // isHost = true
        
        socket.emit('hosted', {
            playerId: socket.id,
            roomId: roomId,
            player: currentRoom.sanitizePlayer(player),
            walls: currentRoom.walls,
            state: currentRoom.state,
            wave: currentRoom.wave,
            players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p))
        });
        
        console.log(`Player ${playerName} (${character}) hosted room ${roomId}`);
    });
    
    // 既存ルームに参加
    socket.on('joinRoom', (data) => {
        const roomId = data.roomId;
        const playerName = data.name || 'Player';
        const character = data.character || 'NAGAL';
        
        // ルームが存在するかチェック
        if (!rooms.has(roomId)) {
            socket.emit('joinError', { message: `Room ${roomId} not found!` });
            return;
        }
        
        const room = rooms.get(roomId);
        
        // 最大4人まで
        if (room.players.size >= 4) {
            socket.emit('joinError', { message: 'Room is full! (Max 4 players)' });
            return;
        }
        
        // ゲーム中は参加不可
        if (room.state === 'playing') {
            socket.emit('joinError', { message: 'Game already in progress!' });
            return;
        }
        
        currentRoom = room;
        socket.join(roomId);
        
        const player = currentRoom.addPlayer(socket, playerName, false, character); // isHost = false
        
        socket.emit('joined', {
            playerId: socket.id,
            roomId: roomId,
            player: currentRoom.sanitizePlayer(player),
            walls: currentRoom.walls,
            state: currentRoom.state,
            wave: currentRoom.wave,
            players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p)),
            isGuest: true
        });
        
        // ホストと他のプレイヤーに通知
        socket.to(roomId).emit('playerJoined', {
            player: currentRoom.sanitizePlayer(player),
            players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p))
        });
        
        console.log(`Player ${playerName} (${character}) joined room ${roomId} as Guest ${player.playerIndex}`);
    });
    
    // ゲストがREADY
    socket.on('playerReady', () => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (player && !player.isHost) {
            player.ready = true;
            
            // 全員に通知
            io.to(currentRoom.id).emit('playerReadyUpdate', {
                playerId: socket.id,
                players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p))
            });
            
            console.log(`Player ${player.name} is READY in room ${currentRoom.id}`);
        }
    });
    
    // ホストがゲーム開始
    socket.on('startGame', () => {
        if (!currentRoom) return;
        if (currentRoom.hostId !== socket.id) return; // ホストのみ開始可能
        if (currentRoom.state !== 'waiting') return;
        
        currentRoom.startGame();
        io.to(currentRoom.id).emit('gameStarted', {
            players: Array.from(currentRoom.players.values()).map(p => currentRoom.sanitizePlayer(p))
        });
        console.log(`Game started in room ${currentRoom.id}`);
    });
    
    // ========== キャラクター固有アクション ==========
    
    // EIRYKLAV: 武器切替
    socket.on('switchWeapon', (data) => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (!player || player.character !== 'EIRYKLAV') return;
        
        if (data.weapon === 'PLAZMER' || data.weapon === 'LASER') {
            player.equipped.activeWeapon = data.weapon;
            console.log(`${player.name} switched to ${data.weapon}`);
        }
    });
    
    // AGOREKIK: 触手バースト
    socket.on('tentacleBurst', (data) => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (!player || player.character !== 'AGOREKIK') return;
        
        player.tentacleBurst = data.active;
        console.log(`${player.name} tentacle burst: ${data.active}`);
    });
    
    // AGOREKIK: 触手攻撃
    socket.on('tentacleAttack', (data) => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (!player || player.character !== 'AGOREKIK') return;
        
        const enemy = currentRoom.enemies.find(e => e.id === data.targetId);
        if (enemy && enemy.hp > 0 && !enemy.isZombie) {
            // 捕食バフ中はダメージ増加
            const damage = player.devourBuff > 0 ? data.damage * 1.5 : data.damage;
            enemy.hp -= damage;
            
            if (enemy.hp <= 0) {
                currentRoom.defeatEnemy(enemy, socket.id);
            }
            
            io.to(currentRoom.id).emit('tentacleHit', {
                playerId: socket.id,
                targetId: data.targetId,
                damage: damage,
                tentacleIndex: data.tentacleIndex
            });
        }
    });
    
    // AGOREKIK: フォーメーション切替（スペースキー）
    socket.on('toggleFormation', (data) => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (!player || player.character !== 'AGOREKIK') return;
        
        // defense ↔ attack 切り替え
        player.tentacleMode = player.tentacleMode === 'defense' ? 'attack' : 'defense';
        
        io.to(currentRoom.id).emit('formationChanged', {
            playerId: socket.id,
            mode: player.tentacleMode
        });
        
        console.log(`${player.name} formation: ${player.tentacleMode}`);
    });
    
    // EIRYKLAV: 武器切替（スペースキー）
    socket.on('switchWeapon', (data) => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (!player || player.character !== 'EIRYKLAV') return;
        
        // PLAZMER ↔ LASER 切り替え
        player.equipped.activeWeapon = player.equipped.activeWeapon === 'PLAZMER' ? 'LASER' : 'PLAZMER';
        
        io.to(currentRoom.id).emit('weaponSwitched', {
            playerId: socket.id,
            weapon: player.equipped.activeWeapon
        });
        
        console.log(`${player.name} weapon: ${player.equipped.activeWeapon}`);
    });
    
    // AGOREKIK: 触手集中命令（旧コード互換用・削除予定）
    socket.on('tentacleConcentrate', (data) => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (!player || player.character !== 'AGOREKIK') return;
        
        // 全触手を指定方向に集中
        player.tentacleConcentrate = {
            active: true,
            angle: data.angle,
            timer: 60 // 1秒間集中
        };
        
        io.to(currentRoom.id).emit('tentacleConcentrated', {
            playerId: socket.id,
            angle: data.angle
        });
        
        console.log(`${player.name} concentrated tentacles to angle ${data.angle}`);
    });
    
    // 武器選択完了
    socket.on('loadoutReady', (data) => {
        if (!currentRoom || currentRoom.state !== 'weaponSelect') return;
        
        const player = currentRoom.players.get(socket.id);
        if (!player) return;
        
        // loadoutを実際の装備に反映
        if (data.passive && Array.isArray(data.passive)) {
            player.equipped = {
                passive: data.passive,
                active: data.active || null
            };
        }
        player.loadoutReady = true;
        
        // 全員に通知
        io.to(currentRoom.id).emit('loadoutReadyUpdate', {
            playerId: socket.id,
            players: Array.from(currentRoom.players.values()).map(p => ({
                id: p.id, name: p.name, loadoutReady: p.loadoutReady || false
            }))
        });
        
        // 全員準備完了チェック
        const allReady = Array.from(currentRoom.players.values()).every(p => p.loadoutReady);
        if (allReady) {
            // 全員準備完了 → 次のWAVE開始
            setTimeout(() => {
                currentRoom.players.forEach(p => p.loadoutReady = false);
                currentRoom.state = 'playing';
                currentRoom.startWave();
                io.to(currentRoom.id).emit('waveStarting');
            }, 1000);
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
    
    socket.on('hit', (data) => {
        if (currentRoom) {
            const remainingHp = currentRoom.damageEnemy(data.enemyId, data.damage, data.weaponType, socket.id);
            // ダメージを全員に通知
            io.to(currentRoom.id).emit('enemyHit', {
                enemyId: data.enemyId,
                damage: data.damage,
                remainingHp: remainingHp
            });
        }
    });
    
    socket.on('destroyBullet', (data) => {
        if (currentRoom) {
            const idx = currentRoom.enemyBullets.findIndex(b => b.id === data.bulletId);
            if (idx !== -1) {
                currentRoom.enemyBullets.splice(idx, 1);
            }
        }
    });
    
    // INTERCEPT爆風 - 範囲内の敵弾を消す
    socket.on('interceptExplosion', (data) => {
        if (currentRoom) {
            // 爆風範囲内の敵弾を消す
            currentRoom.enemyBullets = currentRoom.enemyBullets.filter(b => {
                const dist = Math.hypot(b.x - data.x, b.y - data.y);
                return dist > data.radius;
            });
        }
    });
    
    // ANCHOR - 敵を固定
    socket.on('anchorEnemy', (data) => {
        if (currentRoom) {
            const enemy = currentRoom.enemies.find(e => e.id === data.enemyId);
            if (enemy) {
                enemy.anchored = true;
                enemy.anchorTimer = 180; // 3秒固定
                io.to(currentRoom.id).emit('enemyAnchored', { enemyId: data.enemyId });
            }
        }
    });
    
    // REFLECT - 敵弾反射
    socket.on('reflectBullet', (data) => {
        if (currentRoom) {
            const bullet = currentRoom.enemyBullets.find(b => b.id === data.bulletId);
            if (bullet) {
                // 弾を反射（プレイヤー弾として敵に向かう）
                const speed = Math.hypot(bullet.vx, bullet.vy) * 1.5;
                bullet.vx = Math.cos(data.newAngle) * speed;
                bullet.vy = Math.sin(data.newAngle) * speed;
                bullet.reflected = true;
                bullet.color = '#0af';
                
                // 反射弾で敵にダメージ（敵弾リストから削除してダメージを与える）
                io.to(currentRoom.id).emit('bulletReflected', { 
                    bulletId: data.bulletId,
                    angle: data.newAngle
                });
            }
        }
    });
    
    socket.on('fire', (data) => {
        if (currentRoom) {
            const player = currentRoom.players.get(socket.id);
            if (player) {
                // サンダー発射時はエネルギーをリセット
                if (data.type === 'THUNDER') {
                    player.thunderEnergy = 0;
                }
                // 他のプレイヤーに弾丸を通知
                socket.to(currentRoom.id).emit('remoteFire', {
                    playerId: socket.id,
                    type: data.type,
                    angle: data.angle,
                    x: player.x,
                    y: player.y
                });
            }
        }
    });
    
    // OVERLOAD発動
    socket.on('overloadActivate', () => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (!player || !player.alive) return;
        
        // 発動条件チェック
        const hpRatio = player.hp / (player.maxHp || 100);
        if (hpRatio > 0.5) return;
        if (player.overload.used) return;
        if (currentRoom.wave < 22) return;
        
        // OVERLOAD発動
        player.overload.active = true;
        player.overload.used = true;
        player.overload.timer = 480; // 8秒
        player.invincible = 480; // 8秒無敵
        
        // 全敵に大ダメージ
        currentRoom.enemies.forEach(e => {
            if (e.hp > 0) {
                const damage = e.isBoss ? Math.floor(e.maxHp * 0.3) : 999; // ボスには30%、雑魚は即死
                e.hp -= damage;
                if (e.hp <= 0) {
                    currentRoom.score += e.score || 100;
                }
            }
        });
        
        // 全敵弾を消去
        currentRoom.enemyBullets = [];
        
        // 全員に通知
        io.to(currentRoom.id).emit('overloadActivated', {
            playerId: socket.id,
            playerName: player.name
        });
        
        console.log(`${player.name} activated OVERLOAD!`);
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
server.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log(`PLAZMERS Server Ver.1.0037`);
    console.log(`Running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('========================================');
});