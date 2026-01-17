const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ['websocket', 'polling'], pingTimeout: 60000, pingInterval: 25000 });

app.use(express.static('public'));

const WORLD_W = 3000, WORLD_H = 3000, TICK_RATE = 60;
const MAX_ENEMIES = 80, MAX_ENEMY_BULLETS = 200, MAX_ITEMS = 50, RESPAWN_TIME = 300;

// ========== 10 STAGES - INNER SPACE ==========
const STAGES = [
    { id: 1, name: 'BLOOD VESSEL', nameJP: '血管', color: '#ff3030', wallColor: '#8b0000', bgColor: '#1a0505', desc: '侵食の始まり' },
    { id: 2, name: 'NEURAL NETWORK', nameJP: '神経回路', color: '#00ccff', wallColor: '#004466', bgColor: '#050510', desc: '電気信号の迷宮' },
    { id: 3, name: 'CELL MEMBRANE', nameJP: '細胞膜', color: '#ff66ff', wallColor: '#660066', bgColor: '#100510', desc: '境界の揺らぎ' },
    { id: 4, name: 'LYMPH NODE', nameJP: 'リンパ節', color: '#66ff66', wallColor: '#006600', bgColor: '#051005', desc: '免疫の砦' },
    { id: 5, name: 'HEART CORE', nameJP: '心臓核', color: '#ff0066', wallColor: '#990033', bgColor: '#150008', desc: '脈動する中枢' },
    { id: 6, name: 'BRAIN STEM', nameJP: '脳幹', color: '#ffaacc', wallColor: '#664455', bgColor: '#0a0508', desc: '意識の深淵' },
    { id: 7, name: 'BONE MARROW', nameJP: '骨髄', color: '#ffffaa', wallColor: '#665500', bgColor: '#0a0a05', desc: '生命の源泉' },
    { id: 8, name: 'ALVEOLI', nameJP: '肺胞', color: '#ffcccc', wallColor: '#663333', bgColor: '#0a0505', desc: '呼吸する空間' },
    { id: 9, name: 'DATA STREAM', nameJP: '情報空間', color: '#00ffcc', wallColor: '#006655', bgColor: '#050a0a', desc: '電子の海' },
    { id: 10, name: 'VIRUS CORE', nameJP: 'ウイルス核', color: '#ff00ff', wallColor: '#550055', bgColor: '#0a050a', desc: '最終決戦' }
];

// ========== STAGE BOSSES ==========
const BOSS_DEFS = [
    { name: 'HEMOGLOBIN', nameJP: 'ヘモグロビン', hp: 300, size: 55, pattern: 'spiral' },
    { name: 'SYNAPSE', nameJP: 'シナプス', hp: 400, size: 60, pattern: 'electric' },
    { name: 'MEMBRANE BEAST', nameJP: '膜獣', hp: 500, size: 65, pattern: 'split' },
    { name: 'ANTIBODY', nameJP: '抗体', hp: 600, size: 70, pattern: 'shield' },
    { name: 'CARDIAC', nameJP: 'カーディアック', hp: 800, size: 80, pattern: 'pulse' },
    { name: 'NEURON KING', nameJP: 'ニューロンキング', hp: 1000, size: 85, pattern: 'mind' },
    { name: 'STEM CELL', nameJP: '幹細胞', hp: 1200, size: 90, pattern: 'regen' },
    { name: 'RESPIRATOR', nameJP: 'レスピレーター', hp: 1400, size: 95, pattern: 'breath' },
    { name: 'DATA WORM', nameJP: 'データワーム', hp: 1700, size: 100, pattern: 'glitch' },
    { name: 'VIRUS EMPEROR', nameJP: 'ウイルス皇帝', hp: 2500, size: 120, pattern: 'chaos' }
];

const ENEMY_TYPES = {
    small: { hp: 5, speed: 2.5, size: 12, score: 10 },
    medium: { hp: 15, speed: 2, size: 18, score: 30 },
    large: { hp: 35, speed: 1.5, size: 26, score: 50 },
    tank: { hp: 60, speed: 1, size: 34, score: 100 },
    elite: { hp: 100, speed: 2.2, size: 30, score: 200 }
};

function generateOrganicMaze(stageId) {
    const walls = [];
    const cx = WORLD_W / 2, cy = WORLD_H / 2;
    
    // 外周境界のみ（有機的な形状）- 壁数を半分に
    const segments = 16;
    for (let i = 0; i < segments; i++) {
        const angle = (Math.PI * 2 / segments) * i;
        const radius = 1400 + Math.sin(angle * 3 + stageId * 0.3) * 50;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        walls.push({ x: x - 25, y: y - 25, w: 50, h: 50 });
    }
    
    // ステージごとの内部構造（大幅削減・有機的）
    if (stageId === 1) { // Blood Vessel - シンプルな血管分岐
        walls.push({ x: 800, y: 1200, w: 40, h: 400 });
        walls.push({ x: 2160, y: 1400, w: 40, h: 400 });
    } else if (stageId === 2) { // Neural - 神経シナプス（少量）
        walls.push({ x: 900, y: 900, w: 30, h: 300 });
        walls.push({ x: 2070, y: 1800, w: 30, h: 300 });
    } else if (stageId === 3) { // Cell Membrane - 細胞膜の泡（3つだけ）
        [[1000, 1000], [2000, 1500], [1200, 2000]].forEach(([px, py]) => {
            walls.push({ x: px, y: py, w: 60, h: 60 });
        });
    } else if (stageId === 4) { // Lymph - リンパ節（4角のみ）
        walls.push({ x: 700, y: 700, w: 80, h: 80 });
        walls.push({ x: 2220, y: 700, w: 80, h: 80 });
        walls.push({ x: 700, y: 2220, w: 80, h: 80 });
        walls.push({ x: 2220, y: 2220, w: 80, h: 80 });
    } else if (stageId === 5) { // Heart - 心臓の鼓動（中央に少し）
        walls.push({ x: cx - 200, y: cy - 30, w: 120, h: 60 });
        walls.push({ x: cx + 80, y: cy - 30, w: 120, h: 60 });
    } else if (stageId === 6) { // Brain - 脳のしわ（2本だけ）
        walls.push({ x: 900, y: 800, w: 40, h: 350 });
        walls.push({ x: 2060, y: 1850, w: 40, h: 350 });
    } else if (stageId === 7) { // Bone Marrow - 骨髄（散在5個）
        for (let i = 0; i < 5; i++) {
            const angle = (Math.PI * 2 / 5) * i;
            const r = 600;
            walls.push({ x: cx + Math.cos(angle) * r - 30, y: cy + Math.sin(angle) * r - 30, w: 60, h: 60 });
        }
    } else if (stageId === 8) { // Alveoli - 肺胞（少量）
        walls.push({ x: 800, y: 1100, w: 50, h: 80 });
        walls.push({ x: 2150, y: 1100, w: 50, h: 80 });
        walls.push({ x: 800, y: 1820, w: 50, h: 80 });
        walls.push({ x: 2150, y: 1820, w: 50, h: 80 });
    } else if (stageId === 9) { // Data Stream - 電子の海（超シンプル）
        // 中央に十字のみ
        walls.push({ x: cx - 15, y: cy - 300, w: 30, h: 200 });
        walls.push({ x: cx - 15, y: cy + 100, w: 30, h: 200 });
    } else if (stageId === 10) { // Virus Core - ウイルス核（最小限）
        for (let i = 0; i < 4; i++) {
            const angle = (Math.PI * 2 / 4) * i + Math.PI / 4;
            const r = 500;
            walls.push({ x: cx + Math.cos(angle) * r - 30, y: cy + Math.sin(angle) * r - 30, w: 60, h: 60 });
        }
    }
    return walls;
}

const PLAYER_COLORS = ['#ffffff', '#ffff00', '#00aaff', '#ff66aa']; // P1白, P2黄, P3青, P4ピンク

const rooms = new Map();

class GameRoom {
    constructor(id) {
        this.id = id; this.players = new Map(); this.enemies = []; this.enemyBullets = [];
        this.items = []; this.stage = 1; this.score = 0; this.state = 'waiting';
        this.frame = 0; this.idCounter = 0; this.boss = null; this.killCount = 0;
        this.walls = generateOrganicMaze(1); this.killsNeeded = 15; this.stageTransition = false;
        this.playerIndex = 0;
    }

    getStage() { return STAGES[this.stage - 1]; }

    addPlayer(socket, name, isHost = false) {
        let sx, sy;
        for (let i = 0; i < 50; i++) { sx = WORLD_W / 2 + (Math.random() - 0.5) * 300; sy = WORLD_H / 2 + (Math.random() - 0.5) * 300; if (!this.checkWallCollision(sx, sy, 20)) break; }
        const colorIdx = this.playerIndex % 4;
        this.playerIndex++;
        const player = { id: socket.id, name, x: sx, y: sy, angle: -Math.PI / 2, hp: 100, maxHp: 100, alive: true, score: 0, isHost, invincible: 180, dashing: false, respawnTimer: 0, weapons: { gatling: 1, phalanx: 0, missile: 0, laser: 0, dash: 1 }, autoFire: { gatling: true, phalanx: true, missile: true, laser: true }, phalanxMode: 'atk', phalanxUnits: [], input: { dx: 0, dy: 0, dashing: false }, colorIdx: colorIdx, color: PLAYER_COLORS[colorIdx] };
        this.players.set(socket.id, player); return player;
    }

    checkWallCollision(x, y, r) { for (const w of this.walls) { const cx = Math.max(w.x, Math.min(x, w.x + w.w)); const cy = Math.max(w.y, Math.min(y, w.y + w.h)); if ((x - cx) ** 2 + (y - cy) ** 2 < r ** 2) return true; } return false; }

    resolveWallCollision(x, y, r) { let nx = x, ny = y; for (const w of this.walls) { const cx = Math.max(w.x, Math.min(nx, w.x + w.w)); const cy = Math.max(w.y, Math.min(ny, w.y + w.h)); const dx = nx - cx, dy = ny - cy, d = Math.sqrt(dx * dx + dy * dy); if (d < r && d > 0) { nx += (dx / d) * (r - d) * 1.1; ny += (dy / d) * (r - d) * 1.1; } } return { x: nx, y: ny }; }

    start() { this.state = 'playing'; this.stage = 1; this.score = 0; this.killCount = 0; this.enemies = []; this.enemyBullets = []; this.items = []; this.boss = null; this.walls = generateOrganicMaze(1); this.killsNeeded = 15; io.to(this.id).emit('stageStart', { stage: this.getStage(), stageNum: this.stage, walls: this.walls }); if (!this.loopInterval) this.loopInterval = setInterval(() => this.update(), 1000 / TICK_RATE); }

    spawnBoss() { const def = BOSS_DEFS[this.stage - 1]; const st = this.getStage(); const hpMult = 1 + (this.players.size - 1) * 0.3; this.boss = { id: 'boss_' + this.idCounter++, x: WORLD_W / 2, y: WORLD_H / 2 - 350, hp: Math.floor(def.hp * hpMult), maxHp: Math.floor(def.hp * hpMult), size: def.size, color: st.color, name: def.name, nameJP: def.nameJP, pattern: def.pattern, timer: 0 }; io.to(this.id).emit('bossSpawn', { name: def.name, nameJP: def.nameJP, stage: this.stage }); }

    nextStage() { if (this.stage >= 10) { io.to(this.id).emit('gameComplete', { score: this.score }); this.state = 'complete'; return; } this.stageTransition = true; this.stage++; this.killCount = 0; this.killsNeeded = 12 + this.stage * 4; this.enemies = []; this.enemyBullets = []; this.items = []; this.boss = null; this.walls = generateOrganicMaze(this.stage); this.players.forEach(p => { p.x = WORLD_W / 2 + (Math.random() - 0.5) * 200; p.y = WORLD_H / 2 + (Math.random() - 0.5) * 200; p.hp = Math.min(p.maxHp, p.hp + 50); p.invincible = 180; }); io.to(this.id).emit('stageStart', { stage: this.getStage(), stageNum: this.stage, walls: this.walls }); setTimeout(() => { this.stageTransition = false; }, 2000); }

    update() { if (this.state !== 'playing' || this.stageTransition) return; this.frame++; this.players.forEach(p => { if (p.alive) { if (p.invincible > 0) p.invincible--; const speed = p.input.dashing ? 8 + (p.weapons.dash || 1) * 1.2 : 5; let nx = p.x + p.input.dx * speed, ny = p.y + p.input.dy * speed; if (p.input.dashing) { p.x = Math.max(50, Math.min(WORLD_W - 50, nx)); p.y = Math.max(50, Math.min(WORLD_H - 50, ny)); this.dashAttack(p); } else { const res = this.resolveWallCollision(nx, ny, 15); p.x = Math.max(50, Math.min(WORLD_W - 50, res.x)); p.y = Math.max(50, Math.min(WORLD_H - 50, res.y)); } p.dashing = p.input.dashing; if (p.input.dx !== 0 || p.input.dy !== 0) p.angle = Math.atan2(p.input.dy, p.input.dx); this.updatePhalanx(p); } else { p.respawnTimer++; if (p.respawnTimer >= RESPAWN_TIME) this.respawnPlayer(p); } }); if (!this.boss && this.frame % Math.max(30, 60 - this.stage * 4) === 0) this.spawnEnemy(); this.updateEnemies(); if (this.boss) this.updateBoss(); this.updateBullets(); this.updateItems(); if (!this.boss && this.killCount >= this.killsNeeded) this.spawnBoss(); if (this.frame % 2 === 0) this.broadcast(); }

    dashAttack(p) { const dashDmg = 10 + (p.weapons.dash || 1) * 3; this.enemies.forEach(e => { if (Math.hypot(p.x - e.x, p.y - e.y) < 25 + e.size) { e.hp -= dashDmg; if (e.hp <= 0) { p.score += e.score || 10; this.score += e.score || 10; this.killCount++; this.dropItem(e.x, e.y); } io.to(this.id).emit('dashHit', { x: e.x, y: e.y }); } }); if (this.boss && Math.hypot(p.x - this.boss.x, p.y - this.boss.y) < 25 + this.boss.size) { this.boss.hp -= dashDmg; io.to(this.id).emit('dashHit', { x: this.boss.x, y: this.boss.y }); } }

    respawnPlayer(p) { let sx, sy; for (let i = 0; i < 50; i++) { sx = WORLD_W / 2 + (Math.random() - 0.5) * 300; sy = WORLD_H / 2 + (Math.random() - 0.5) * 300; if (!this.checkWallCollision(sx, sy, 20)) break; } p.alive = true; p.hp = p.maxHp; p.x = sx; p.y = sy; p.invincible = 180; p.respawnTimer = 0; io.to(p.id).emit('respawned'); }

    updatePhalanx(p) { const lv = p.weapons.phalanx; if (lv <= 0) { p.phalanxUnits = []; return; } 
        // ユニット数の調整
        while (p.phalanxUnits.length < lv) p.phalanxUnits.push({ angle: Math.random() * Math.PI * 2, dist: 50 + Math.random() * 30, state: 'orbit', targetX: 0, targetY: 0, attackTimer: 0 }); 
        while (p.phalanxUnits.length > lv) p.phalanxUnits.pop();
        
        if (p.phalanxMode === 'atk') {
            // ATKモード：敵に向かって一列→分散攻撃
            let target = null, minD = 400;
            this.enemies.forEach(e => { const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < minD) { minD = d; target = e; } });
            if (this.boss) { const d = Math.hypot(this.boss.x - p.x, this.boss.y - p.y); if (d < minD) { minD = d; target = this.boss; } }
            
            p.phalanxUnits.forEach((f, i) => {
                if (target && minD < 350) {
                    f.state = 'attack';
                    const formAngle = Math.atan2(target.y - p.y, target.x - p.x);
                    const spreadAngle = formAngle + (i - (p.phalanxUnits.length - 1) / 2) * 0.3;
                    const targetDist = Math.min(minD - 30, 120 + Math.sin(this.frame * 0.1 + i) * 40);
                    f.targetX = p.x + Math.cos(spreadAngle) * targetDist;
                    f.targetY = p.y + Math.sin(spreadAngle) * targetDist;
                    f.angle = Math.atan2(f.targetY - p.y, f.targetX - p.x);
                    f.dist += (targetDist - f.dist) * 0.15;
                } else {
                    f.state = 'orbit';
                    f.angle += 0.05;
                    f.dist += (60 - f.dist) * 0.1;
                }
            });
            
            // 攻撃判定
            if (this.frame % 10 === 0) {
                p.phalanxUnits.forEach(f => {
                    if (f.state !== 'attack') return;
                    const fx = p.x + Math.cos(f.angle) * f.dist, fy = p.y + Math.sin(f.angle) * f.dist;
                    let hit = null, hitD = 60;
                    this.enemies.forEach(e => { const d = Math.hypot(e.x - fx, e.y - fy); if (d < hitD) { hitD = d; hit = e; } });
                    if (this.boss) { const d = Math.hypot(this.boss.x - fx, this.boss.y - fy); if (d < hitD) { hitD = d; hit = this.boss; } }
                    if (hit) { hit.hp -= 4 + lv; io.to(this.id).emit('phalanxShot', { x: fx, y: fy, tx: hit.x, ty: hit.y, mode: 'atk' }); }
                });
            }
        } else {
            // DEFモード：周回防御
            p.phalanxUnits.forEach(f => { f.angle += 0.04; f.dist += (55 - f.dist) * 0.1; f.state = 'orbit'; });
            if (this.frame % 8 === 0) {
                p.phalanxUnits.forEach(f => {
                    const fx = p.x + Math.cos(f.angle) * f.dist, fy = p.y + Math.sin(f.angle) * f.dist;
                    let destroyed = 0;
                    this.enemyBullets = this.enemyBullets.filter(b => { if (Math.hypot(b.x - fx, b.y - fy) < 45) { destroyed++; return false; } return true; });
                    if (destroyed > 0) io.to(this.id).emit('phalanxShot', { x: fx, y: fy, tx: fx, ty: fy, mode: 'def', count: destroyed });
                });
            }
        }
    }

    spawnEnemy() { if (this.enemies.length >= MAX_ENEMIES) return; const types = Object.keys(ENEMY_TYPES); const weights = [40 - this.stage * 3, 30, 15 + this.stage, 10 + this.stage, 5 + this.stage * 2]; let roll = Math.random() * 100, idx = 0; for (let i = 0; i < weights.length; i++) { roll -= Math.max(5, weights[i]); if (roll <= 0) { idx = i; break; } } const t = ENEMY_TYPES[types[idx]]; let ex, ey; for (let i = 0; i < 50; i++) { const side = Math.floor(Math.random() * 4), m = 250; if (side === 0) { ex = m + Math.random() * (WORLD_W - m * 2); ey = m; } else if (side === 1) { ex = m + Math.random() * (WORLD_W - m * 2); ey = WORLD_H - m; } else if (side === 2) { ex = m; ey = m + Math.random() * (WORLD_H - m * 2); } else { ex = WORLD_W - m; ey = m + Math.random() * (WORLD_H - m * 2); } if (!this.checkWallCollision(ex, ey, t.size)) break; } const st = this.getStage(); this.enemies.push({ id: 'e_' + this.idCounter++, x: ex, y: ey, hp: Math.floor(t.hp * (1 + this.stage * 0.1)), maxHp: Math.floor(t.hp * (1 + this.stage * 0.1)), speed: t.speed, size: t.size, color: st.color, score: t.score, shootTimer: Math.random() * 60 }); }

    updateEnemies() { this.enemies = this.enemies.filter(e => { if (e.hp <= 0) return false; let tx = WORLD_W / 2, ty = WORLD_H / 2, minD = Infinity; this.players.forEach(p => { if (p.alive) { const d = Math.hypot(p.x - e.x, p.y - e.y); if (d < minD) { minD = d; tx = p.x; ty = p.y; } } }); const a = Math.atan2(ty - e.y, tx - e.x); const res = this.resolveWallCollision(e.x + Math.cos(a) * e.speed, e.y + Math.sin(a) * e.speed, e.size); e.x = res.x; e.y = res.y; e.shootTimer--; if (e.shootTimer <= 0 && this.enemyBullets.length < MAX_ENEMY_BULLETS && minD < 400) { this.enemyBullets.push({ x: e.x, y: e.y, vx: Math.cos(a) * 4, vy: Math.sin(a) * 4, life: 150 }); e.shootTimer = 90 + Math.random() * 60; } this.players.forEach(p => { if (!p.alive || p.invincible > 0) return; if (Math.hypot(p.x - e.x, p.y - e.y) < 15 + e.size) { p.hp -= 15; p.invincible = 60; if (p.hp <= 0) { p.alive = false; p.respawnTimer = 0; io.to(p.id).emit('died'); } } }); return true; }); }

    updateBoss() { if (!this.boss) return; if (this.boss.hp <= 0) { this.score += 1000 * this.stage; for (let i = 0; i < 5; i++) this.dropItem(this.boss.x + (Math.random() - 0.5) * 100, this.boss.y + (Math.random() - 0.5) * 100, true); io.to(this.id).emit('bossDefeated', { stage: this.stage, name: this.boss.name }); this.boss = null; setTimeout(() => { if (this.state === 'playing') this.nextStage(); }, 3000); return; } this.boss.timer++; let tx = WORLD_W / 2, ty = WORLD_H / 2; this.players.forEach(p => { if (p.alive) { tx = p.x; ty = p.y; } }); const a = Math.atan2(ty - this.boss.y, tx - this.boss.x); const speed = 1.5 + this.stage * 0.15; const res = this.resolveWallCollision(this.boss.x + Math.cos(a) * speed * 0.6, this.boss.y + Math.sin(a) * speed * 0.6, this.boss.size); this.boss.x = Math.max(200, Math.min(WORLD_W - 200, res.x)); this.boss.y = Math.max(200, Math.min(WORLD_H - 200, res.y)); const fireRate = Math.max(20, 50 - this.stage * 3); if (this.boss.timer % fireRate === 0 && this.enemyBullets.length < MAX_ENEMY_BULLETS) { this.fireBossPattern(a); } this.players.forEach(p => { if (!p.alive || p.invincible > 0) return; if (Math.hypot(p.x - this.boss.x, p.y - this.boss.y) < 20 + this.boss.size) { p.hp -= 25; p.invincible = 90; if (p.hp <= 0) { p.alive = false; p.respawnTimer = 0; io.to(p.id).emit('died'); } } }); }

    fireBossPattern(targetAngle) { const b = this.boss, cnt = 8 + this.stage; if (b.pattern === 'spiral') { for (let i = 0; i < cnt; i++) { const ba = (Math.PI * 2 / cnt) * i + b.timer * 0.05; this.enemyBullets.push({ x: b.x, y: b.y, vx: Math.cos(ba) * 4, vy: Math.sin(ba) * 4, life: 200, boss: true }); } } else if (b.pattern === 'electric') { for (let i = -2; i <= 2; i++) { const ba = targetAngle + i * 0.2; this.enemyBullets.push({ x: b.x, y: b.y, vx: Math.cos(ba) * 6, vy: Math.sin(ba) * 6, life: 150, boss: true }); } } else if (b.pattern === 'pulse') { for (let i = 0; i < 16; i++) { const ba = (Math.PI * 2 / 16) * i + b.timer * 0.02; this.enemyBullets.push({ x: b.x, y: b.y, vx: Math.cos(ba) * 5, vy: Math.sin(ba) * 5, life: 120, boss: true }); } } else if (b.pattern === 'glitch') { for (let i = 0; i < cnt * 2; i++) { const ba = Math.random() * Math.PI * 2; this.enemyBullets.push({ x: b.x + (Math.random() - 0.5) * 100, y: b.y + (Math.random() - 0.5) * 100, vx: Math.cos(ba) * 5, vy: Math.sin(ba) * 5, life: 150, boss: true }); } } else if (b.pattern === 'chaos') { for (let i = 0; i < cnt * 2; i++) { const ba = (Math.PI * 2 / (cnt * 2)) * i + b.timer * 0.08; const spd = 3 + Math.sin(i + b.timer * 0.1) * 2; this.enemyBullets.push({ x: b.x, y: b.y, vx: Math.cos(ba) * spd, vy: Math.sin(ba) * spd, life: 250, boss: true }); } } else { for (let i = 0; i < cnt; i++) { const ba = (Math.PI * 2 / cnt) * i; this.enemyBullets.push({ x: b.x, y: b.y, vx: Math.cos(ba) * 3.5, vy: Math.sin(ba) * 3.5, life: 180, boss: true }); } } }

    updateBullets() { this.enemyBullets = this.enemyBullets.filter(b => { b.x += b.vx; b.y += b.vy; b.life--; if (b.life <= 0 || this.checkWallCollision(b.x, b.y, 3)) return false; let hit = false; this.players.forEach(p => { if (!p.alive || p.invincible > 0) return; if (Math.hypot(p.x - b.x, p.y - b.y) < 14) { p.hp -= b.boss ? 12 : 8; p.invincible = 30; hit = true; if (p.hp <= 0) { p.alive = false; p.respawnTimer = 0; io.to(p.id).emit('died'); } } }); return !hit; }); }

    updateItems() { this.items = this.items.filter(item => { let col = false; this.players.forEach(p => { if (p.alive && Math.hypot(p.x - item.x, p.y - item.y) < 35) { col = true; this.collectItem(p, item); } }); return !col; }); }

    collectItem(p, item) { switch (item.type) { case 'HP': p.hp = Math.min(p.maxHp, p.hp + 30); break; case 'GATLING': p.weapons.gatling = Math.min(10, p.weapons.gatling + 1); break; case 'PHALANX': p.weapons.phalanx = Math.min(10, p.weapons.phalanx + 1); break; case 'MISSILE': p.weapons.missile = Math.min(10, p.weapons.missile + 1); break; case 'LASER': p.weapons.laser = Math.min(10, p.weapons.laser + 1); break; case 'DASH': p.weapons.dash = Math.min(10, p.weapons.dash + 1); break; } io.to(p.id).emit('itemCollected', { type: item.type }); }

    dropItem(x, y, isBoss = false) { if (this.items.length >= MAX_ITEMS) return; const types = ['HP', 'GATLING', 'PHALANX', 'MISSILE', 'LASER', 'DASH']; if (isBoss) this.items.push({ id: 'i_' + this.idCounter++, x, y, type: types[1 + Math.floor(Math.random() * 5)] }); else if (Math.random() < 0.25) this.items.push({ id: 'i_' + this.idCounter++, x, y, type: types[Math.floor(Math.random() * types.length)] }); }

    handleAttack(playerId, data) { const p = this.players.get(playerId); if (!p || !p.alive || !data.targets) return; data.targets.forEach(t => { let target = t.id === this.boss?.id ? this.boss : this.enemies.find(e => e.id === t.id); if (!target || target.hp <= 0) return; target.hp -= t.damage || 1; if (target.hp <= 0 && target !== this.boss) { p.score += target.score || 10; this.score += target.score || 10; this.killCount++; this.dropItem(target.x, target.y); } }); }

    handleMissileExplosion(data) { this.enemyBullets = this.enemyBullets.filter(b => Math.hypot(b.x - data.x, b.y - data.y) > data.radius); }

    broadcast() { const st = this.getStage(); const state = { players: [], enemies: this.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp, size: e.size, color: e.color })), boss: this.boss ? { id: this.boss.id, x: this.boss.x, y: this.boss.y, hp: this.boss.hp, maxHp: this.boss.maxHp, size: this.boss.size, color: this.boss.color, name: this.boss.name, nameJP: this.boss.nameJP } : null, bullets: this.enemyBullets.map(b => ({ x: b.x, y: b.y, boss: b.boss })), items: this.items, stage: this.stage, score: this.score, stageInfo: st, killCount: this.killCount, killsNeeded: this.killsNeeded, walls: this.walls }; this.players.forEach(p => { state.players.push({ id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle, hp: p.hp, maxHp: p.maxHp, alive: p.alive, dashing: p.dashing, invincible: p.invincible, weapons: p.weapons, autoFire: p.autoFire, phalanxMode: p.phalanxMode, phalanxUnits: p.phalanxUnits, score: p.score, respawnTimer: p.respawnTimer, color: p.color, colorIdx: p.colorIdx }); }); io.to(this.id).emit('state', state); }

    stop() { if (this.loopInterval) { clearInterval(this.loopInterval); this.loopInterval = null; } }
}

function generateRoomCode() { return String(Math.floor(1000 + Math.random() * 9000)); }

io.on('connection', (socket) => {
    let currentRoom = null;
    socket.on('hostRoom', (data) => { const name = data.name || 'Host', roomId = generateRoomCode(); const room = new GameRoom(roomId); rooms.set(roomId, room); currentRoom = room; socket.join(roomId); const player = room.addPlayer(socket, name, true); socket.emit('hosted', { roomId, playerId: socket.id, player, walls: room.walls, worldW: WORLD_W, worldH: WORLD_H, stages: STAGES }); });
    socket.on('joinRoom', (data) => { const roomId = data.roomId, name = data.name || 'Player'; if (!rooms.has(roomId)) { socket.emit('joinError', { message: 'Room not found' }); return; } const room = rooms.get(roomId); if (room.players.size >= 4) { socket.emit('joinError', { message: 'Room is full' }); return; } currentRoom = room; socket.join(roomId); const player = room.addPlayer(socket, name, false); socket.emit('joined', { roomId, playerId: socket.id, player, players: Array.from(room.players.values()), walls: room.walls, worldW: WORLD_W, worldH: WORLD_H, stages: STAGES }); socket.to(roomId).emit('playerJoined', { player }); });
    socket.on('startGame', () => { if (!currentRoom) return; const p = currentRoom.players.get(socket.id); if (!p?.isHost) return; currentRoom.start(); io.to(currentRoom.id).emit('gameStarted'); });
    socket.on('input', (data) => { if (!currentRoom) return; const p = currentRoom.players.get(socket.id); if (p) p.input = { dx: data.dx || 0, dy: data.dy || 0, dashing: data.dashing || false }; });
    socket.on('toggleWeapon', (data) => { if (!currentRoom) return; const p = currentRoom.players.get(socket.id); if (p && p.autoFire.hasOwnProperty(data.weapon)) p.autoFire[data.weapon] = !p.autoFire[data.weapon]; });
    socket.on('togglePhalanxMode', () => { if (!currentRoom) return; const p = currentRoom.players.get(socket.id); if (p) p.phalanxMode = p.phalanxMode === 'atk' ? 'def' : 'atk'; });
    socket.on('attack', (data) => { if (currentRoom) currentRoom.handleAttack(socket.id, data); });
    socket.on('missileExplosion', (data) => { if (currentRoom) currentRoom.handleMissileExplosion(data); });
    socket.on('disconnect', () => { if (currentRoom) { currentRoom.players.delete(socket.id); if (currentRoom.players.size === 0) { currentRoom.stop(); rooms.delete(currentRoom.id); } else io.to(currentRoom.id).emit('playerLeft', { playerId: socket.id }); } });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('PLAZMERS Ver.1.011 - INNER SPACE Server on port ' + PORT));