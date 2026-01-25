const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const GAME_W = 400, GAME_H = 600;
const TICK_RATE = 30; // 60→30に下げてカクツキ軽減

const UNITS = {
    normal:   { name: 'ノーマル', hp: 1, speed: 1, cost: 10, color: '#0f0', score: 10 },
    tank:     { name: 'タンク', hp: 40, speed: 0.6, cost: 25, color: '#088', score: 30 },
    fast:     { name: 'スピード', hp: 8, speed: 2, cost: 15, color: '#ff0', score: 15 },
    shooter:  { name: 'シューター', hp: 15, speed: 0.8, cost: 30, color: '#f80', score: 25, canShoot: true },
    shield:   { name: 'シールド', hp: 20, speed: 0.7, cost: 35, color: '#08f', score: 35, hasShield: true },
    split:    { name: 'スプリット', hp: 12, speed: 1, cost: 30, color: '#f0f', score: 20, splits: true },
    kamikaze: { name: 'カミカゼ', hp: 5, speed: 3, cost: 20, color: '#f00', score: 20, kamikaze: true },
    healer:   { name: 'ヒーラー', hp: 15, speed: 0.8, cost: 40, color: '#0ff', score: 40, heals: true },
    bomb:     { name: 'ボム', hp: 10, speed: 1, cost: 25, color: '#f60', score: 25, explodes: true }
};

const rooms = new Map();

class GameRoom {
    constructor(id, mode, cpuLevel, timeLimit) {
        this.id = id;
        this.mode = mode;
        this.cpuLevel = cpuLevel || 2;
        this.timeLimit = timeLimit;
        this.fighter = null;
        this.invader = null;
        this.state = 'waiting';
        this.gameState = null;
        this.loopInterval = null;
    }

    initGame() {
        this.gameState = {
            fighter: { x: GAME_W / 2, y: GAME_H - 60, lives: 3, weapons: { gatling: 1, missile: 0, laser: 0, phalanx: 0 }, phalanxTrail: [], invincible: 0, alive: true },
            boss: { x: GAME_W / 2, y: 50, hp: 500, maxHp: 500, dir: 1 },
            invaders: [], invaderBullets: [], fighterBullets: [], missiles: [], lasers: [], items: [],
            resource: 50, resourceMax: 200, resourceRate: 1 + this.cpuLevel * 0.3,
            score: 0, time: 0, winner: null
        };
        this.state = 'playing';
        this.startLoop();
    }

    startLoop() {
        if (this.loopInterval) clearInterval(this.loopInterval);
        this.loopInterval = setInterval(() => this.update(), 1000 / TICK_RATE);
    }

    stopLoop() {
        if (this.loopInterval) { clearInterval(this.loopInterval); this.loopInterval = null; }
    }

    update() {
        if (this.state !== 'playing') return;
        const gs = this.gameState;
        gs.time++;
        gs.resource = Math.min(gs.resourceMax, gs.resource + gs.resourceRate / TICK_RATE);
        gs.boss.x += gs.boss.dir * 1.5;
        if (gs.boss.x < 50) { gs.boss.x = 50; gs.boss.dir = 1; }
        if (gs.boss.x > GAME_W - 50) { gs.boss.x = GAME_W - 50; gs.boss.dir = -1; }
        if (gs.time % 45 === 0 && gs.fighter.alive) {
            const angle = Math.atan2(gs.fighter.y - gs.boss.y, gs.fighter.x - gs.boss.x);
            for (let i = -1; i <= 1; i++) {
                gs.invaderBullets.push({ x: gs.boss.x, y: gs.boss.y + 30, vx: Math.cos(angle + i * 0.2) * 4, vy: Math.sin(angle + i * 0.2) * 4, boss: true });
            }
        }
        if (gs.fighter.invincible > 0) gs.fighter.invincible--;
        this.updateInvaders();
        this.updateBullets();
        this.updateItems();
        if (this.mode === 'cpu-invader') this.cpuInvaderAI();
        if (this.mode === 'cpu-fighter') this.cpuFighterAI();
        if (gs.boss.hp <= 0) { gs.winner = 'fighter'; this.state = 'ended'; this.broadcast('gameEnd', { winner: 'fighter', score: gs.score }); this.stopLoop(); }
        if (!gs.fighter.alive && gs.fighter.lives <= 0) { gs.winner = 'invader'; this.state = 'ended'; this.broadcast('gameEnd', { winner: 'invader', score: gs.score }); this.stopLoop(); }
        if (this.timeLimit > 0 && gs.time >= this.timeLimit * TICK_RATE) { gs.winner = gs.boss.hp < gs.boss.maxHp * 0.5 ? 'fighter' : 'invader'; this.state = 'ended'; this.broadcast('gameEnd', { winner: gs.winner, score: gs.score, timeout: true }); this.stopLoop(); }
        this.broadcast('state', this.getState());
    }

    updateInvaders() {
        const gs = this.gameState;
        gs.invaders = gs.invaders.filter(inv => {
            if (inv.hp <= 0) {
                gs.score += UNITS[inv.type].score;
                if (Math.random() < 0.3) { const types = ['gatling', 'missile', 'laser', 'phalanx', 'life']; gs.items.push({ x: inv.x, y: inv.y, type: types[Math.floor(Math.random() * types.length)], life: 300 }); }
                if (inv.splits && !inv.isSplit) { for (let i = 0; i < 2; i++) { gs.invaders.push({ ...inv, x: inv.x + (i === 0 ? -15 : 15), hp: 6, isSplit: true, id: Date.now() + Math.random() }); } }
                if (inv.explodes) { for (let i = 0; i < 8; i++) { const a = (Math.PI * 2 / 8) * i; gs.invaderBullets.push({ x: inv.x, y: inv.y, vx: Math.cos(a) * 3, vy: Math.sin(a) * 3 }); } }
                return false;
            }
            if (inv.phase === 'enter') { inv.enterTimer--; inv.x += inv.enterVx; inv.y += inv.enterVy; if (inv.enterTimer <= 0) { inv.phase = 'position'; inv.targetX = inv.gridX; inv.targetY = inv.gridY; } }
            else if (inv.phase === 'position') { const dx = inv.targetX - inv.x, dy = inv.targetY - inv.y, dist = Math.hypot(dx, dy); if (dist > 2) { inv.x += (dx / dist) * inv.speed * 2; inv.y += (dy / dist) * inv.speed * 2; } else { inv.x = inv.targetX; inv.y = inv.targetY; inv.phase = 'idle'; } }
            else if (inv.phase === 'idle') { if (inv.canShoot && Math.random() < 0.01) { gs.invaderBullets.push({ x: inv.x, y: inv.y, vx: 0, vy: 3 }); } if (inv.kamikaze && gs.fighter.alive) { inv.phase = 'attack'; } if (inv.heals && gs.time % 30 === 0) { gs.invaders.forEach(other => { if (other !== inv && Math.hypot(other.x - inv.x, other.y - inv.y) < 50) { other.hp = Math.min(UNITS[other.type].hp, other.hp + 2); } }); } }
            else if (inv.phase === 'attack') { const dx = gs.fighter.x - inv.x, dy = gs.fighter.y - inv.y, dist = Math.hypot(dx, dy); inv.x += (dx / dist) * inv.speed * 3; inv.y += (dy / dist) * inv.speed * 3; }
            if (inv.hasShield) { inv.shieldActive = gs.invaders.some(other => other !== inv && other.y > inv.y && Math.abs(other.x - inv.x) < 30); }
            return true;
        });
    }

    updateBullets() {
        const gs = this.gameState;
        gs.fighterBullets = gs.fighterBullets.filter(b => { b.x += b.vx; b.y += b.vy; if (b.y < 0 || b.y > GAME_H) return false; if (Math.hypot(b.x - gs.boss.x, b.y - gs.boss.y) < 40) { gs.boss.hp -= b.damage || 1; return false; } for (const inv of gs.invaders) { if (inv.shieldActive && b.y < inv.y) continue; if (Math.hypot(b.x - inv.x, b.y - inv.y) < 15) { inv.hp -= b.damage || 1; return false; } } return true; });
        gs.missiles = gs.missiles.filter(m => { let target = null, minDist = 200; for (const inv of gs.invaders) { const d = Math.hypot(inv.x - m.x, inv.y - m.y); if (d < minDist) { minDist = d; target = inv; } } if (!target && Math.hypot(gs.boss.x - m.x, gs.boss.y - m.y) < 200) { target = gs.boss; } if (target) { const a = Math.atan2(target.y - m.y, target.x - m.x); m.vx += Math.cos(a) * 0.3; m.vy += Math.sin(a) * 0.3; const spd = Math.hypot(m.vx, m.vy); if (spd > 6) { m.vx = m.vx / spd * 6; m.vy = m.vy / spd * 6; } } m.x += m.vx; m.y += m.vy; m.life--; if (m.life <= 0 || m.y < 0) return false; if (Math.hypot(m.x - gs.boss.x, m.y - gs.boss.y) < 45) { gs.boss.hp -= 10; return false; } for (const inv of gs.invaders) { if (Math.hypot(m.x - inv.x, m.y - inv.y) < 20) { inv.hp -= 10; return false; } } return true; });
        gs.lasers = gs.lasers.filter(l => { l.life--; if (l.life % 3 === 0) { for (const inv of gs.invaders) { if (Math.abs(inv.x - l.x) < l.width / 2 && inv.y < l.y) { inv.hp -= 3; } } if (Math.abs(gs.boss.x - l.x) < l.width / 2 + 30) { gs.boss.hp -= 5; } } return l.life > 0; });
        gs.invaderBullets = gs.invaderBullets.filter(b => { b.x += b.vx; b.y += b.vy; if (b.y > GAME_H || b.y < 0 || b.x < 0 || b.x > GAME_W) return false; if (gs.fighter.alive && gs.fighter.invincible <= 0) { if (Math.hypot(b.x - gs.fighter.x, b.y - gs.fighter.y) < 12) { this.hitFighter(); return false; } } return true; });
    }

    hitFighter() { const gs = this.gameState; gs.fighter.lives--; if (gs.fighter.lives > 0) { gs.fighter.invincible = 90; gs.fighter.x = GAME_W / 2; gs.fighter.y = GAME_H - 60; this.broadcast('fighterHit', { lives: gs.fighter.lives }); } else { gs.fighter.alive = false; } }

    updateItems() { const gs = this.gameState; gs.items = gs.items.filter(item => { item.life--; item.y += 0.5; if (item.life <= 0 || item.y > GAME_H) return false; if (gs.fighter.alive && Math.hypot(item.x - gs.fighter.x, item.y - gs.fighter.y) < 20) { if (item.type === 'life') { gs.fighter.lives = Math.min(5, gs.fighter.lives + 1); } else { gs.fighter.weapons[item.type] = Math.min(5, (gs.fighter.weapons[item.type] || 0) + 1); } this.broadcast('itemGet', { type: item.type }); return false; } return true; }); }

    spawnInvaders(type, count = 5) {
        const gs = this.gameState; const unit = UNITS[type]; if (!unit) return false; if (gs.resource < unit.cost * count) return false; gs.resource -= unit.cost * count;
        const gridRows = 5, gridCols = 8, cellW = GAME_W / gridCols, cellH = 40; const occupied = new Set(); gs.invaders.forEach(inv => { if (inv.phase === 'idle' || inv.phase === 'position') { const gx = Math.round(inv.gridX / cellW); const gy = Math.round((inv.gridY - 80) / cellH); occupied.add(`${gx},${gy}`); } });
        const freeSpots = []; for (let row = 0; row < gridRows; row++) { for (let col = 0; col < gridCols; col++) { if (!occupied.has(`${col},${row}`)) { freeSpots.push({ col, row }); } } }
        if (freeSpots.length < count) count = freeSpots.length; if (count === 0) return false;
        const spots = []; for (let i = 0; i < count && freeSpots.length > 0; i++) { const idx = Math.floor(Math.random() * freeSpots.length); spots.push(freeSpots.splice(idx, 1)[0]); }
        const enterX = Math.random() < 0.5 ? -30 : GAME_W + 30, enterY = 100;
        spots.forEach((spot, i) => { const gridX = (spot.col + 0.5) * cellW, gridY = 80 + spot.row * cellH; gs.invaders.push({ id: Date.now() + Math.random(), type: type, x: enterX, y: enterY + i * 20, hp: unit.hp, speed: unit.speed, phase: 'enter', enterTimer: 30 + i * 5, enterVx: (GAME_W / 2 - enterX) / 30, enterVy: 1, gridX: gridX, gridY: gridY, canShoot: unit.canShoot, hasShield: unit.hasShield, splits: unit.splits, kamikaze: unit.kamikaze, heals: unit.heals, explodes: unit.explodes }); });
        return true;
    }

    cpuInvaderAI() { const gs = this.gameState, level = this.cpuLevel, spawnChance = 0.01 + level * 0.005; if (Math.random() < spawnChance && gs.resource >= 50) { const types = Object.keys(UNITS), weights = [30, 15, 20, 15 + level * 2, 10, 10, 15, 5 + level, 10]; let roll = Math.random() * weights.reduce((a, b) => a + b), typeIdx = 0; for (let i = 0; i < weights.length; i++) { roll -= weights[i]; if (roll <= 0) { typeIdx = i; break; } } this.spawnInvaders(types[typeIdx], Math.min(5, 2 + level)); } }

    cpuFighterAI() { const gs = this.gameState; if (!gs.fighter.alive) return; const level = this.cpuLevel; let nearestThreat = null, nearestDist = Infinity; gs.invaderBullets.forEach(b => { const d = Math.hypot(b.x - gs.fighter.x, b.y - gs.fighter.y); if (d < nearestDist && b.y > gs.fighter.y - 100) { nearestDist = d; nearestThreat = { x: b.x, y: b.y, type: 'bullet' }; } }); gs.invaders.forEach(inv => { if (inv.kamikaze || inv.y > gs.fighter.y - 150) { const d = Math.hypot(inv.x - gs.fighter.x, inv.y - gs.fighter.y); if (d < nearestDist) { nearestDist = d; nearestThreat = { x: inv.x, y: inv.y, type: 'invader' }; } } }); let targetX = gs.fighter.x, targetY = gs.fighter.y; if (nearestThreat && nearestDist < 100 + level * 20) { targetX = gs.fighter.x + (gs.fighter.x > nearestThreat.x ? 50 : -50); } else { let bestTarget = gs.boss; gs.invaders.forEach(inv => { if (inv.phase === 'idle' && inv.y < bestTarget.y + 50) { bestTarget = inv; } }); targetX = bestTarget.x; targetY = GAME_H - 60 - level * 10; } const dx = targetX - gs.fighter.x, dy = targetY - gs.fighter.y, moveSpeed = 3 + level * 0.5; if (Math.abs(dx) > 5) gs.fighter.x += Math.sign(dx) * Math.min(moveSpeed, Math.abs(dx)); if (Math.abs(dy) > 5) gs.fighter.y += Math.sign(dy) * Math.min(moveSpeed, Math.abs(dy)); if (gs.time % Math.max(4, 10 - level) === 0) { this.fighterShoot(); } }

    fighterShoot() { const gs = this.gameState; if (!gs.fighter.alive) return; const f = gs.fighter, gLv = f.weapons.gatling; if (gLv > 0) { const spread = gLv >= 3 ? [-0.15, 0, 0.15] : gLv >= 2 ? [-0.08, 0.08] : [0]; spread.forEach(a => { gs.fighterBullets.push({ x: f.x, y: f.y - 15, vx: Math.sin(a) * 8, vy: -8, damage: 1 + gLv * 0.3 }); }); } if (f.weapons.missile > 0 && gs.time % 15 === 0) { gs.missiles.push({ x: f.x - 10, y: f.y, vx: -1, vy: -4, life: 180 }); gs.missiles.push({ x: f.x + 10, y: f.y, vx: 1, vy: -4, life: 180 }); } if (f.weapons.laser > 0 && gs.time % 30 === 0) { gs.lasers.push({ x: f.x, y: f.y, width: 10 + f.weapons.laser * 5, life: 20 }); } }

    moveFighter(dx, dy) { const gs = this.gameState; if (!gs.fighter.alive) return; const speed = 5; gs.fighter.x = Math.max(20, Math.min(GAME_W - 20, gs.fighter.x + dx * speed)); gs.fighter.y = Math.max(GAME_H / 2, Math.min(GAME_H - 20, gs.fighter.y + dy * speed)); gs.fighter.phalanxTrail.unshift({ x: gs.fighter.x, y: gs.fighter.y }); if (gs.fighter.phalanxTrail.length > 30) gs.fighter.phalanxTrail.pop(); }

    getState() { return this.gameState; }
    broadcast(event, data) { io.to(this.id).emit(event, data); }
}

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    socket.on('startCpuGame', (data) => { const { role, cpuLevel, timeLimit } = data; const roomId = 'cpu_' + socket.id; const mode = role === 'fighter' ? 'cpu-invader' : 'cpu-fighter'; const room = new GameRoom(roomId, mode, cpuLevel, timeLimit); rooms.set(roomId, room); socket.join(roomId); socket.roomId = roomId; socket.role = role; if (role === 'fighter') { room.fighter = socket.id; } else { room.invader = socket.id; } room.initGame(); socket.emit('gameStart', { roomId, role, gameState: room.getState() }); });
    socket.on('hostPvp', (data) => { const roomId = Math.random().toString(36).substring(2, 6).toUpperCase(); const room = new GameRoom(roomId, 'pvp', 0, data.timeLimit); rooms.set(roomId, room); socket.join(roomId); socket.roomId = roomId; socket.role = data.role; if (data.role === 'fighter') { room.fighter = socket.id; } else { room.invader = socket.id; } socket.emit('hosted', { roomId, role: data.role }); });
    socket.on('joinPvp', (data) => { const room = rooms.get(data.roomId); if (!room) { socket.emit('joinError', { message: 'ルームが見つかりません' }); return; } if (room.state !== 'waiting') { socket.emit('joinError', { message: 'ゲームは既に開始しています' }); return; } socket.join(data.roomId); socket.roomId = data.roomId; if (!room.fighter) { room.fighter = socket.id; socket.role = 'fighter'; } else if (!room.invader) { room.invader = socket.id; socket.role = 'invader'; } socket.emit('joined', { roomId: data.roomId, role: socket.role }); if (room.fighter && room.invader) { room.initGame(); io.to(data.roomId).emit('gameStart', { roomId: data.roomId, gameState: room.getState() }); } });
    socket.on('fighterInput', (data) => { const room = rooms.get(socket.roomId); if (!room || socket.role !== 'fighter') return; room.moveFighter(data.dx, data.dy); if (data.shoot) room.fighterShoot(); });
    socket.on('spawnUnit', (data) => { const room = rooms.get(socket.roomId); if (!room || socket.role !== 'invader') return; const success = room.spawnInvaders(data.type, data.count || 5); socket.emit('spawnResult', { success, resource: room.gameState.resource }); });
    socket.on('disconnect', () => { console.log('Disconnected:', socket.id); if (socket.roomId) { const room = rooms.get(socket.roomId); if (room) { room.stopLoop(); rooms.delete(socket.roomId); } } });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('PLAZMERS Ver.1.00 Server on port ' + PORT));
