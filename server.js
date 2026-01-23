const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ['websocket', 'polling'], pingTimeout: 60000, pingInterval: 25000 });

app.use(express.static('public'));

const WORLD_W = 3000, WORLD_H = 3000, TICK_RATE = 60;
const MAX_ENEMIES = 60, MAX_ENEMY_BULLETS = 200, MAX_ITEMS = 50, RESPAWN_TIME = 300;

// ========== 6 STAGES - INNER SPACE ==========
const STAGES = [
    { id: 1, name: 'BLOOD VESSEL', nameJP: '血管', color: '#ff3030', wallColor: '#8b0000', bgColor: '#1a0505', desc: 'チュートリアル' },
    { id: 2, name: 'NEURAL NETWORK', nameJP: '神経回路', color: '#00ccff', wallColor: '#004466', bgColor: '#050510', desc: '電気信号の迷宮' },
    { id: 3, name: 'CELL MEMBRANE', nameJP: '細胞膜', color: '#ff66ff', wallColor: '#660066', bgColor: '#100510', desc: '境界の揺らぎ' },
    { id: 4, name: 'LYMPH NODE', nameJP: 'リンパ節', color: '#66ff66', wallColor: '#006600', bgColor: '#051005', desc: '免疫の砦' },
    { id: 5, name: 'HEART CORE', nameJP: '心臓核', color: '#ff0066', wallColor: '#990033', bgColor: '#150008', desc: '脈動する中枢' },
    { id: 6, name: 'VIRUS CORE', nameJP: 'ウイルス核', color: '#ff00ff', wallColor: '#550055', bgColor: '#0a050a', desc: '最終決戦' }
];

// ========== STAGE BOSSES - Stage 3+ has WARNING ==========
const BOSS_DEFS = [
    { name: 'HEMOGLOBIN', nameJP: 'ヘモグロビン', hp: 200, size: 50, pattern: 'spiral', warning: false },
    { name: 'SYNAPSE', nameJP: 'シナプス', hp: 350, size: 55, pattern: 'electric', warning: false },
    { name: 'MEMBRANE BEAST', nameJP: '膜獣', hp: 550, size: 65, pattern: 'split', warning: true },
    { name: 'ANTIBODY', nameJP: '抗体', hp: 800, size: 75, pattern: 'shield', warning: true },
    { name: 'CARDIAC', nameJP: 'カーディアック', hp: 1100, size: 90, pattern: 'pulse', warning: true },
    { name: 'VIRUS EMPEROR', nameJP: 'ウイルス皇帝', hp: 2500, size: 160, pattern: 'chaos', warning: true, isFinalBoss: true }
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
    
    // 外周境界（有機的な形状）
    const segments = 16;
    for (let i = 0; i < segments; i++) {
        const angle = (Math.PI * 2 / segments) * i;
        const radius = 1400 + Math.sin(angle * 3 + stageId * 0.3) * 50;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        walls.push({ x: x - 25, y: y - 25, w: 50, h: 50 });
    }
    
    // 四隅の壁（境界明確化）
    const cs = 180, th = 35;
    walls.push({ x: 100, y: 100, w: cs, h: th }, { x: 100, y: 100, w: th, h: cs });
    walls.push({ x: WORLD_W - 100 - cs, y: 100, w: cs, h: th }, { x: WORLD_W - 100 - th, y: 100, w: th, h: cs });
    walls.push({ x: 100, y: WORLD_H - 100 - th, w: cs, h: th }, { x: 100, y: WORLD_H - 100 - cs, w: th, h: cs });
    walls.push({ x: WORLD_W - 100 - cs, y: WORLD_H - 100 - th, w: cs, h: th }, { x: WORLD_W - 100 - th, y: WORLD_H - 100 - cs, w: th, h: cs });
    
    // ステージごとの内部構造
    if (stageId === 1) { /* チュートリアル - 壁なし */ }
    else if (stageId === 2) { walls.push({ x: 900, y: 900, w: 30, h: 300 }, { x: 2070, y: 1800, w: 30, h: 300 }); }
    else if (stageId === 3) { [[1000, 1000], [2000, 1500], [1200, 2000]].forEach(([px, py]) => walls.push({ x: px, y: py, w: 60, h: 60 })); }
    else if (stageId === 4) { [[700, 700], [2220, 700], [700, 2220], [2220, 2220]].forEach(([px, py]) => walls.push({ x: px, y: py, w: 80, h: 80 })); }
    else if (stageId === 5) { walls.push({ x: cx - 200, y: cy - 30, w: 120, h: 60 }, { x: cx + 80, y: cy - 30, w: 120, h: 60 }); }
    else if (stageId === 6) { for (let i = 0; i < 4; i++) { const a = (Math.PI * 2 / 4) * i + Math.PI / 4, r = 700; walls.push({ x: cx + Math.cos(a) * r - 30, y: cy + Math.sin(a) * r - 30, w: 60, h: 60 }); } }
    return walls;
}

const PLAYER_COLORS = ['#ffffff', '#ffff00', '#00aaff', '#ff66aa'];
const rooms = new Map();

class GameRoom {
    constructor(id) {
        this.id = id; this.players = new Map(); this.enemies = []; this.enemyBullets = [];
        this.items = []; this.stage = 1; this.score = 0; this.state = 'waiting';
        this.frame = 0; this.idCounter = 0; this.boss = null; this.killCount = 0;
        this.walls = generateOrganicMaze(1); this.killsNeeded = 6; this.stageTransition = false;
        this.playerIndex = 0; this.warningActive = false;
    }

    getStage() { return STAGES[Math.min(this.stage - 1, STAGES.length - 1)]; }

    addPlayer(socket, name, isHost) {
        let sx, sy;
        for (let i = 0; i < 50; i++) { sx = WORLD_W / 2 + (Math.random() - 0.5) * 300; sy = WORLD_H / 2 + (Math.random() - 0.5) * 300; if (!this.checkWallCollision(sx, sy, 20)) break; }
        const colorIdx = this.playerIndex % 4;
        this.playerIndex++;
        const player = { id: socket.id, name, x: sx, y: sy, angle: -Math.PI / 2, hp: 100, maxHp: 100, alive: true, score: 0, isHost, invincible: 180, dashing: false, respawnTimer: 0, weapons: { gatling: 1, phalanx: 0, missile: 0, laser: 0, dash: 1 }, autoFire: { gatling: true, phalanx: true, missile: true, laser: true }, phalanxMode: 'atk', phalanxUnits: [], input: { dx: 0, dy: 0, dashing: false }, colorIdx, color: PLAYER_COLORS[colorIdx] };
        this.players.set(socket.id, player); return player;
    }

    checkWallCollision(x, y, r) { for (const w of this.walls) { const cx = Math.max(w.x, Math.min(x, w.x + w.w)); const cy = Math.max(w.y, Math.min(y, w.y + w.h)); if ((x - cx) ** 2 + (y - cy) ** 2 < r ** 2) return true; } return false; }
    resolveWallCollision(x, y, r) { let nx = x, ny = y; for (const w of this.walls) { const cx = Math.max(w.x, Math.min(nx, w.x + w.w)); const cy = Math.max(w.y, Math.min(ny, w.y + w.h)); const dx = nx - cx, dy = ny - cy, d = Math.sqrt(dx * dx + dy * dy); if (d < r && d > 0) { nx += (dx / d) * (r - d) * 1.1; ny += (dy / d) * (r - d) * 1.1; } } return { x: nx, y: ny }; }

    start() { this.state = 'playing'; this.stage = 1; this.score = 0; this.killCount = 0; this.enemies = []; this.enemyBullets = []; this.items = []; this.boss = null; this.walls = generateOrganicMaze(1); this.killsNeeded = 6; io.to(this.id).emit('stageStart', { stage: this.getStage(), stageNum: this.stage, walls: this.walls, totalStages: 6 }); if (!this.loopInterval) this.loopInterval = setInterval(() => this.update(), 1000 / TICK_RATE); }

    spawnBoss() { 
        const def = BOSS_DEFS[this.stage - 1]; if (!def) return; 
        const st = this.getStage(); const hpMult = 1 + (this.players.size - 1) * 0.3;
        if (def.warning) {
            this.warningActive = true;
            io.to(this.id).emit('bossWarning', { name: def.name, nameJP: def.nameJP, stage: this.stage, isFinalBoss: def.isFinalBoss || false });
            setTimeout(() => { this.warningActive = false; this.actuallySpawnBoss(def, st, hpMult); }, 3500);
        } else { this.actuallySpawnBoss(def, st, hpMult); }
    }
    
    actuallySpawnBoss(def, st, hpMult) { 
        this.boss = { id: 'boss_' + this.idCounter++, x: WORLD_W / 2, y: WORLD_H / 2 - 350, hp: Math.floor(def.hp * hpMult), maxHp: Math.floor(def.hp * hpMult), size: def.size, color: st.color, name: def.name, nameJP: def.nameJP, pattern: def.pattern, timer: 0, isFinalBoss: def.isFinalBoss || false }; 
        io.to(this.id).emit('bossSpawn', { name: def.name, nameJP: def.nameJP, stage: this.stage, isFinalBoss: def.isFinalBoss || false, size: def.size }); 
    }

    nextStage() { 
        if (this.stage >= 6) { io.to(this.id).emit('gameComplete', { score: this.score }); this.state = 'complete'; return; } 
        this.stageTransition = true; this.stage++; this.killCount = 0; 
        this.killsNeeded = 6 + this.stage * 3;
        this.enemies = []; this.enemyBullets = []; this.items = []; this.boss = null; 
        this.walls = generateOrganicMaze(this.stage); 
        this.players.forEach(p => { p.x = WORLD_W / 2 + (Math.random() - 0.5) * 200; p.y = WORLD_H / 2 + (Math.random() - 0.5) * 200; p.hp = Math.min(p.maxHp, p.hp + 50); p.invincible = 180; }); 
        io.to(this.id).emit('stageStart', { stage: this.getStage(), stageNum: this.stage, walls: this.walls, totalStages: 6 }); 
        setTimeout(() => { this.stageTransition = false; }, 2000); 
    }

    update() { 
        if (this.state !== 'playing' || this.stageTransition || this.warningActive) return; 
        this.frame++; 
        this.players.forEach(p => { 
            if (p.alive) { 
                if (p.invincible > 0) p.invincible--; 
                const speed = p.input.dashing ? 8 + (p.weapons.dash || 1) * 1.2 : 5; 
                let nx = p.x + p.input.dx * speed, ny = p.y + p.input.dy * speed; 
                if (p.input.dashing) { p.x = Math.max(50, Math.min(WORLD_W - 50, nx)); p.y = Math.max(50, Math.min(WORLD_H - 50, ny)); this.dashAttack(p); } 
                else { const res = this.resolveWallCollision(nx, ny, 15); p.x = Math.max(50, Math.min(WORLD_W - 50, res.x)); p.y = Math.max(50, Math.min(WORLD_H - 50, res.y)); } 
                p.dashing = p.input.dashing; 
                if (p.input.dx !== 0 || p.input.dy !== 0) p.angle = Math.atan2(p.input.dy, p.input.dx); 
                this.updatePhalanx(p); 
            } else { p.respawnTimer++; if (p.respawnTimer >= RESPAWN_TIME) this.respawnPlayer(p); } 
        }); 
        const spawnRate = this.stage === 1 ? 90 : Math.max(35, 65 - this.stage * 5);
        if (!this.boss && this.frame % spawnRate === 0) this.spawnEnemy(); 
        this.updateEnemies(); if (this.boss) this.updateBoss(); this.updateBullets(); this.updateItems(); 
        if (!this.boss && this.killCount >= this.killsNeeded) this.spawnBoss(); 
        if (this.frame % 2 === 0) this.broadcast(); 
    }

    dashAttack(p) { const dashDmg = 10 + (p.weapons.dash || 1) * 3; this.enemies.forEach(e => { if (Math.hypot(p.x - e.x, p.y - e.y) < 25 + e.size) { e.hp -= dashDmg; if (e.hp <= 0) { p.score += e.score || 10; this.score += e.score || 10; this.killCount++; this.dropItem(e.x, e.y); } io.to(this.id).emit('dashHit', { x: e.x, y: e.y }); } }); if (this.boss && Math.hypot(p.x - this.boss.x, p.y - this.boss.y) < 25 + this.boss.size) { this.boss.hp -= dashDmg; io.to(this.id).emit('dashHit', { x: this.boss.x, y: this.boss.y }); } }
    respawnPlayer(p) { let sx, sy; for (let i = 0; i < 50; i++) { sx = WORLD_W / 2 + (Math.random() - 0.5) * 300; sy = WORLD_H / 2 + (Math.random() - 0.5) * 300; if (!this.checkWallCollision(sx, sy, 20)) break; } p.alive = true; p.hp = p.maxHp; p.x = sx; p.y = sy; p.invincible = 180; p.respawnTimer = 0; io.to(p.id).emit('respawned'); }

    updatePhalanx(p) { 
        const lv = p.weapons.phalanx; if (lv <= 0) { p.phalanxUnits = []; return; } 
        while (p.phalanxUnits.length < lv) p.phalanxUnits.push({ angle: Math.random() * Math.PI * 2, dist: 50 + Math.random() * 30, state: 'orbit' }); 
        while (p.phalanxUnits.length > lv) p.phalanxUnits.pop();
        if (p.phalanxMode === 'atk') {
            let target = null, minD = 400;
            this.enemies.forEach(e => { const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < minD) { minD = d; target = e; } });
            if (this.boss) { const d = Math.hypot(this.boss.x - p.x, this.boss.y - p.y); if (d < minD) { minD = d; target = this.boss; } }
            p.phalanxUnits.forEach((f, i) => {
                if (target && minD < 350) { f.state = 'attack'; const formAngle = Math.atan2(target.y - p.y, target.x - p.x); const spreadAngle = formAngle + (i - (p.phalanxUnits.length - 1) / 2) * 0.3; const targetDist = Math.min(minD - 30, 120 + Math.sin(this.frame * 0.1 + i) * 40); f.angle = spreadAngle; f.dist += (targetDist - f.dist) * 0.15; }
                else { f.state = 'orbit'; f.angle += 0.05; f.dist += (60 - f.dist) * 0.1; }
            });
            if (this.frame % 10 === 0) { p.phalanxUnits.forEach(f => { if (f.state !== 'attack') return; const fx = p.x + Math.cos(f.angle) * f.dist, fy = p.y + Math.sin(f.angle) * f.dist; let hit = null, hitD = 60; this.enemies.forEach(e => { const d = Math.hypot(e.x - fx, e.y - fy); if (d < hitD) { hitD = d; hit = e; } }); if (this.boss) { const d = Math.hypot(this.boss.x - fx, this.boss.y - fy); if (d < hitD) { hitD = d; hit = this.boss; } } if (hit) { hit.hp -= 4 + lv; io.to(this.id).emit('phalanxShot', { x: fx, y: fy, tx: hit.x, ty: hit.y, mode: 'atk' }); } }); }
        } else {
            p.phalanxUnits.forEach(f => { f.angle += 0.04; f.dist += (55 - f.dist) * 0.1; f.state = 'orbit'; });
            if (this.frame % 8 === 0) { p.phalanxUnits.forEach(f => { const fx = p.x + Math.cos(f.angle) * f.dist, fy = p.y + Math.sin(f.angle) * f.dist; let destroyed = 0; this.enemyBullets = this.enemyBullets.filter(b => { if (Math.hypot(b.x - fx, b.y - fy) < 45) { destroyed++; return false; } return true; }); if (destroyed > 0) io.to(this.id).emit('phalanxShot', { x: fx, y: fy, tx: fx, ty: fy, mode: 'def', count: destroyed }); }); }
        }
    }

    spawnEnemy() { if (this.enemies.length >= MAX_ENEMIES) return; const types = Object.keys(ENEMY_TYPES); const weights = [40 - this.stage * 3, 30, 15 + this.stage, 10 + this.stage, 5 + this.stage * 2]; let roll = Math.random() * 100, idx = 0; for (let i = 0; i < weights.length; i++) { roll -= Math.max(5, weights[i]); if (roll <= 0) { idx = i; break; } } const t = ENEMY_TYPES[types[idx]]; let ex, ey; for (let i = 0; i < 50; i++) { const side = Math.floor(Math.random() * 4), m = 250; if (side === 0) { ex = m + Math.random() * (WORLD_W - m * 2); ey = m; } else if (side === 1) { ex = m + Math.random() * (WORLD_W - m * 2); ey = WORLD_H - m; } else if (side === 2) { ex = m; ey = m + Math.random() * (WORLD_H - m * 2); } else { ex = WORLD_W - m; ey = m + Math.random() * (WORLD_H - m * 2); } if (!this.checkWallCollision(ex, ey, t.size)) break; } const st = this.getStage(); this.enemies.push({ id: 'e_' + this.idCounter++, x: ex, y: ey, hp: Math.floor(t.hp * (1 + this.stage * 0.1)), maxHp: Math.floor(t.hp * (1 + this.stage * 0.1)), speed: t.speed, size: t.size, color: st.color, score: t.score, shootTimer: Math.random() * 60 }); }

    updateEnemies() { this.enemies = this.enemies.filter(e => { if (e.hp <= 0) return false; let tx = WORLD_W / 2, ty = WORLD_H / 2, minD = Infinity; this.players.forEach(p => { if (p.alive) { const d = Math.hypot(p.x - e.x, p.y - e.y); if (d < minD) { minD = d; tx = p.x; ty = p.y; } } }); const a = Math.atan2(ty - e.y, tx - e.x); const res = this.resolveWallCollision(e.x + Math.cos(a) * e.speed, e.y + Math.sin(a) * e.speed, e.size); e.x = res.x; e.y = res.y; e.shootTimer--; if (e.shootTimer <= 0 && this.enemyBullets.length < MAX_ENEMY_BULLETS && minD < 400) { this.enemyBullets.push({ x: e.x, y: e.y, vx: Math.cos(a) * 4, vy: Math.sin(a) * 4, life: 150 }); e.shootTimer = 90 + Math.random() * 60; } this.players.forEach(p => { if (!p.alive || p.invincible > 0) return; if (Math.hypot(p.x - e.x, p.y - e.y) < 15 + e.size) { p.hp -= 15; p.invincible = 60; if (p.hp <= 0) { p.alive = false; p.respawnTimer = 0; io.to(p.id).emit('died'); } } }); return true; }); }

    updateBoss() { if (!this.boss) return; if (this.boss.hp <= 0) { this.score += 1000 * this.stage; for (let i = 0; i < 5; i++) this.dropItem(this.boss.x + (Math.random() - 0.5) * 100, this.boss.y + (Math.random() - 0.5) * 100, true); io.to(this.id).emit('bossDefeated', { stage: this.stage, name: this.boss.name }); this.boss = null; setTimeout(() => { if (this.state === 'playing') this.nextStage(); }, 3000); return; } this.boss.timer++; let tx = WORLD_W / 2, ty = WORLD_H / 2; this.players.forEach(p => { if (p.alive) { tx = p.x; ty = p.y; } }); const a = Math.atan2(ty - this.boss.y, tx - this.boss.x); const speed = this.boss.isFinalBoss ? 1 : 1.5 + this.stage * 0.15; const res = this.resolveWallCollision(this.boss.x + Math.cos(a) * speed * 0.6, this.boss.y + Math.sin(a) * speed * 0.6, this.boss.size); this.boss.x = Math.max(200, Math.min(WORLD_W - 200, res.x)); this.boss.y = Math.max(200, Math.min(WORLD_H - 200, res.y)); const fireRate = Math.max(15, 45 - this.stage * 4); if (this.boss.timer % fireRate === 0 && this.enemyBullets.length < MAX_ENEMY_BULLETS) { this.fireBossPattern(a); } this.players.forEach(p => { if (!p.alive || p.invincible > 0) return; if (Math.hypot(p.x - this.boss.x, p.y - this.boss.y) < 20 + this.boss.size) { p.hp -= 25; p.invincible = 90; if (p.hp <= 0) { p.alive = false; p.respawnTimer = 0; io.to(p.id).emit('died'); } } }); }

    fireBossPattern(targetAngle) { const b = this.boss, cnt = 8 + this.stage; if (b.pattern === 'spiral') { for (let i = 0; i < cnt; i++) { const ba = (Math.PI * 2 / cnt) * i + b.timer * 0.05; this.enemyBullets.push({ x: b.x, y: b.y, vx: Math.cos(ba) * 4, vy: Math.sin(ba) * 4, life: 200, boss: true }); } } else if (b.pattern === 'electric') { for (let i = -2; i <= 2; i++) { const ba = targetAngle + i * 0.2; this.enemyBullets.push({ x: b.x, y: b.y, vx: Math.cos(ba) * 6, vy: Math.sin(ba) * 6, life: 150, boss: true }); } } else if (b.pattern === 'split') { for (let i = 0; i < 12; i++) { const ba = (Math.PI * 2 / 12) * i; this.enemyBullets.push({ x: b.x, y: b.y, vx: Math.cos(ba) * 5, vy: Math.sin(ba) * 5, life: 140, boss: true }); } } else if (b.pattern === 'shield') { for (let i = 0; i < 16; i++) { const ba = (Math.PI * 2 / 16) * i + b.timer * 0.02; this.enemyBullets.push({ x: b.x, y: b.y, vx: Math.cos(ba) * 4, vy: Math.sin(ba) * 4, life: 160, boss: true }); } } else if (b.pattern === 'pulse') { for (let i = 0; i < 20; i++) { const ba = (Math.PI * 2 / 20) * i + b.timer * 0.03; this.enemyBullets.push({ x: b.x, y: b.y, vx: Math.cos(ba) * 5, vy: Math.sin(ba) * 5, life: 180, boss: true }); } } else if (b.pattern === 'chaos') { for (let i = 0; i < cnt * 3; i++) { const ba = (Math.PI * 2 / (cnt * 3)) * i + b.timer * 0.08; const spd = 3 + Math.sin(i + b.timer * 0.1) * 2; this.enemyBullets.push({ x: b.x + (Math.random() - 0.5) * 50, y: b.y + (Math.random() - 0.5) * 50, vx: Math.cos(ba) * spd, vy: Math.sin(ba) * spd, life: 250, boss: true }); } } else { for (let i = 0; i < cnt; i++) { const ba = (Math.PI * 2 / cnt) * i; this.enemyBullets.push({ x: b.x, y: b.y, vx: Math.cos(ba) * 3.5, vy: Math.sin(ba) * 3.5, life: 180, boss: true }); } } }

    updateBullets() { this.enemyBullets = this.enemyBullets.filter(b => { b.x += b.vx; b.y += b.vy; b.life--; if (b.life <= 0 || b.x < 0 || b.x > WORLD_W || b.y < 0 || b.y > WORLD_H) return false; for (const w of this.walls) { if (b.x > w.x && b.x < w.x + w.w && b.y > w.y && b.y < w.y + w.h) return false; } this.players.forEach(p => { if (!p.alive || p.invincible > 0) return; if (Math.hypot(p.x - b.x, p.y - b.y) < 18) { p.hp -= b.boss ? 15 : 10; p.invincible = 30; if (p.hp <= 0) { p.alive = false; p.respawnTimer = 0; io.to(p.id).emit('died'); } b.life = 0; } }); return b.life > 0; }); }

    dropItem(x, y, guaranteed = false) { if (this.items.length >= MAX_ITEMS) return; if (!guaranteed && Math.random() > 0.35) return; const types = ['HP', 'GATLING', 'PHALANX', 'MISSILE', 'LASER', 'DASH']; const weights = [15, 20, 15, 20, 15, 15]; let roll = Math.random() * 100, idx = 0; for (let i = 0; i < weights.length; i++) { roll -= weights[i]; if (roll <= 0) { idx = i; break; } } this.items.push({ id: 'i_' + this.idCounter++, x, y, type: types[idx], life: 600 }); }

    updateItems() { this.items = this.items.filter(item => { item.life--; if (item.life <= 0) return false; this.players.forEach(p => { if (!p.alive) return; if (Math.hypot(p.x - item.x, p.y - item.y) < 35) { if (item.type === 'HP') { p.hp = Math.min(p.maxHp, p.hp + 30); } else { const w = item.type.toLowerCase(); if (p.weapons[w] !== undefined && p.weapons[w] < 10) p.weapons[w]++; } io.to(p.id).emit('itemCollected', { type: item.type }); item.life = 0; } }); return item.life > 0; }); }

    handleAttack(playerId, data) { const p = this.players.get(playerId); if (!p || !p.alive || !data.targets) return; data.targets.forEach(t => { let target = t.id === this.boss?.id ? this.boss : this.enemies.find(e => e.id === t.id); if (!target || target.hp <= 0) return; target.hp -= t.damage || 1; if (target.hp <= 0 && target !== this.boss) { p.score += target.score || 10; this.score += target.score || 10; this.killCount++; this.dropItem(target.x, target.y); } }); }
    handleMissileExplosion(data) { this.enemyBullets = this.enemyBullets.filter(b => Math.hypot(b.x - data.x, b.y - data.y) > data.radius); }
    handleDestroyBullet(data) { this.enemyBullets = this.enemyBullets.filter(b => Math.hypot(b.x - data.x, b.y - data.y) > 15); }
    handlePlayerBullets(playerId, data) { const p = this.players.get(playerId); if (!p) return; p.bulletData = data.bullets || []; p.missileData = data.missiles || []; p.laserData = data.laser || null; }

    broadcast() { const st = this.getStage(); const playerBullets = []; const playerMissiles = []; const playerLasers = []; this.players.forEach(p => { if (p.bulletData) p.bulletData.forEach(b => playerBullets.push({ ...b, color: p.color })); if (p.missileData) p.missileData.forEach(m => playerMissiles.push({ ...m, color: p.color })); if (p.laserData) playerLasers.push({ ...p.laserData, color: p.color }); }); const state = { players: [], enemies: this.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp, size: e.size, color: e.color })), boss: this.boss ? { id: this.boss.id, x: this.boss.x, y: this.boss.y, hp: this.boss.hp, maxHp: this.boss.maxHp, size: this.boss.size, color: this.boss.color, name: this.boss.name, nameJP: this.boss.nameJP, isFinalBoss: this.boss.isFinalBoss } : null, bullets: this.enemyBullets.map(b => ({ x: b.x, y: b.y, boss: b.boss })), playerBullets, playerMissiles, playerLasers, items: this.items, stage: this.stage, score: this.score, stageInfo: st, killCount: this.killCount, killsNeeded: this.killsNeeded, walls: this.walls }; this.players.forEach(p => { state.players.push({ id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle, hp: p.hp, maxHp: p.maxHp, alive: p.alive, dashing: p.dashing, invincible: p.invincible, weapons: p.weapons, autoFire: p.autoFire, phalanxMode: p.phalanxMode, phalanxUnits: p.phalanxUnits, score: p.score, respawnTimer: p.respawnTimer, color: p.color, colorIdx: p.colorIdx }); }); io.to(this.id).emit('state', state); }
    
    removePlayer(playerId) { const wasHost = this.players.get(playerId)?.isHost; this.players.delete(playerId); if (this.players.size === 0) return false; if (wasHost) { const newHost = this.players.values().next().value; if (newHost) { newHost.isHost = true; io.to(newHost.id).emit('becameHost'); } } return true; }
    stop() { if (this.loopInterval) { clearInterval(this.loopInterval); this.loopInterval = null; } }
}

function generateRoomCode() { return String(Math.floor(1000 + Math.random() * 9000)); }

io.on('connection', (socket) => {
    let currentRoom = null;
    socket.on('hostRoom', (data) => { const name = data.name || 'Host', roomId = generateRoomCode(); const room = new GameRoom(roomId); rooms.set(roomId, room); currentRoom = room; socket.join(roomId); const player = room.addPlayer(socket, name, true); socket.emit('hosted', { roomId, playerId: socket.id, player, walls: room.walls, worldW: WORLD_W, worldH: WORLD_H, totalStages: 6 }); });
    socket.on('joinRoom', (data) => { const roomId = data.roomId, name = data.name || 'Player'; if (!rooms.has(roomId)) { socket.emit('joinError', { message: 'Room not found' }); return; } const room = rooms.get(roomId); if (room.players.size >= 4) { socket.emit('joinError', { message: 'Room is full' }); return; } currentRoom = room; socket.join(roomId); const player = room.addPlayer(socket, name, false); socket.emit('joined', { roomId, playerId: socket.id, player, players: Array.from(room.players.values()), walls: room.walls, worldW: WORLD_W, worldH: WORLD_H, totalStages: 6, gameStarted: room.state === 'playing' }); socket.to(roomId).emit('playerJoined', { player }); });
    socket.on('startGame', () => { if (!currentRoom) return; const p = currentRoom.players.get(socket.id); if (!p?.isHost) return; currentRoom.start(); io.to(currentRoom.id).emit('gameStarted'); });
    socket.on('input', (data) => { if (!currentRoom) return; const p = currentRoom.players.get(socket.id); if (p) p.input = { dx: data.dx || 0, dy: data.dy || 0, dashing: data.dashing || false }; });
    socket.on('toggleWeapon', (data) => { if (!currentRoom) return; const p = currentRoom.players.get(socket.id); if (p && p.autoFire.hasOwnProperty(data.weapon)) p.autoFire[data.weapon] = !p.autoFire[data.weapon]; });
    socket.on('togglePhalanxMode', () => { if (!currentRoom) return; const p = currentRoom.players.get(socket.id); if (p) p.phalanxMode = p.phalanxMode === 'atk' ? 'def' : 'atk'; });
    socket.on('attack', (data) => { if (currentRoom) currentRoom.handleAttack(socket.id, data); });
    socket.on('playerBullets', (data) => { if (currentRoom) currentRoom.handlePlayerBullets(socket.id, data); });
    socket.on('missileExplosion', (data) => { if (currentRoom) currentRoom.handleMissileExplosion(data); });
    socket.on('destroyBullet', (data) => { if (currentRoom) currentRoom.handleDestroyBullet(data); });
    socket.on('disconnect', () => { if (currentRoom) { const roomStillActive = currentRoom.removePlayer(socket.id); if (!roomStillActive) { currentRoom.stop(); rooms.delete(currentRoom.id); } else { io.to(currentRoom.id).emit('playerLeft', { playerId: socket.id }); } } });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('PLAZMERS Ver.1.013 - INNER SPACE Server on port ' + PORT));