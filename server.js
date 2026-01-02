const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static('public'));

const WORLD_W = 2400;
const WORLD_H = 2400;
const PLAYER_COLORS = ['#00f2ff', '#ff6600', '#00ff66', '#ff00ff'];
const WEAPONS = ['NORMAL', 'SPREAD', 'LASER', 'MISSILE', 'REFLECT', 'FLAME', 'FREEZE', 'THUNDER', 'PLASMA', 'BOOMERANG'];

let players = {};
let enemies = {};
let items = [];
let walls = [];
let wave = 0;
let enemyIdCounter = 0;
let itemIdCounter = 0;
let gameStarted = false;
let hostId = null;
let bossActive = false;
let mobSpawnTimer = 0;

// 壁を生成
function generateWalls() {
    walls = [];
    const wallCount = 15 + wave * 3;
    
    for (let i = 0; i < wallCount; i++) {
        const isHorizontal = Math.random() > 0.5;
        const w = isHorizontal ? 100 + Math.random() * 200 : 30;
        const h = isHorizontal ? 30 : 100 + Math.random() * 200;
        
        let x, y, valid = false;
        for (let attempt = 0; attempt < 20; attempt++) {
            x = 200 + Math.random() * (WORLD_W - 400);
            y = 200 + Math.random() * (WORLD_H - 400);
            
            // 中央付近は避ける（スポーン地点）
            const centerDist = Math.sqrt((x - WORLD_W/2)**2 + (y - WORLD_H/2)**2);
            if (centerDist > 300) {
                valid = true;
                break;
            }
        }
        
        if (valid) {
            walls.push({ x, y, w, h, id: 'wall_' + i });
        }
    }
    
    return walls;
}

function generateSpawnPosition() {
    let x, y, valid = false;
    
    for (let attempt = 0; attempt < 50; attempt++) {
        const side = Math.floor(Math.random() * 4);
        switch(side) {
            case 0: x = Math.random() * WORLD_W; y = -50; break;
            case 1: x = WORLD_W + 50; y = Math.random() * WORLD_H; break;
            case 2: x = Math.random() * WORLD_W; y = WORLD_H + 50; break;
            case 3: x = -50; y = Math.random() * WORLD_H; break;
        }
        valid = true;
        break;
    }
    
    return { x, y };
}

function spawnEnemy() {
    const pos = generateSpawnPosition();
    const types = ['normal', 'fast', 'tank', 'shooter'];
    const type = types[Math.floor(Math.random() * types.length)];
    
    const stats = {
        normal: { hp: 3 + wave, speed: 1.5, size: 20, color: '#f0f' },
        fast: { hp: 2 + Math.floor(wave/2), speed: 3, size: 15, color: '#ff0' },
        tank: { hp: 8 + wave * 2, speed: 0.8, size: 30, color: '#f80' },
        shooter: { hp: 4 + wave, speed: 1, size: 22, color: '#f00' }
    };
    
    const id = 'enemy_' + (enemyIdCounter++);
    const s = stats[type];
    const enemy = {
        id, x: pos.x, y: pos.y, type,
        hp: s.hp, maxHp: s.hp, speed: s.speed, size: s.size, color: s.color, angle: 0
    };
    
    enemies[id] = enemy;
    return enemy;
}

function spawnBoss() {
    const playerCount = Object.keys(players).length || 1;
    const bossTypes = ['GUARDIAN', 'DESTROYER', 'SWARM', 'TITAN', 'PHANTOM'];
    const bossType = bossTypes[(wave - 1) % bossTypes.length];
    
    const baseHp = 150 + wave * 50;
    const scaledHp = Math.floor(baseHp * (1 + (playerCount - 1) * 0.4));
    
    const id = 'boss_' + (enemyIdCounter++);
    const boss = {
        id, x: WORLD_W / 2, y: 200,
        type: 'boss', bossType,
        hp: scaledHp, maxHp: scaledHp,
        speed: 1.2, size: 70, color: '#f00',
        isBoss: true, angle: 0
    };
    
    enemies[id] = boss;
    bossActive = true;
    
    // 新しいWaveでは壁を再生成
    walls = generateWalls();
    
    io.emit('bossSpawn', { boss, walls });
    return boss;
}

function spawnItem(x, y) {
    const types = ['power', 'weapon', 'option', 'bomb', 'heal'];
    const weights = [40, 20, 15, 10, 15];
    
    const total = weights.reduce((a, b) => a + b, 0);
    let rand = Math.random() * total;
    let type = types[0];
    for (let i = 0; i < types.length; i++) {
        rand -= weights[i];
        if (rand <= 0) { type = types[i]; break; }
    }
    
    const id = 'item_' + (itemIdCounter++);
    const item = { id, x, y, type };
    items.push(item);
    return item;
}

function findNearestPlayer(x, y) {
    let nearest = null, minDist = Infinity;
    Object.values(players).forEach(p => {
        if (p.hp <= 0) return;
        const d = Math.sqrt((p.x - x)**2 + (p.y - y)**2);
        if (d < minDist) { minDist = d; nearest = p; }
    });
    return nearest;
}

// 壁との衝突判定
function checkWallCollision(x, y, radius) {
    for (const wall of walls) {
        const closestX = Math.max(wall.x, Math.min(x, wall.x + wall.w));
        const closestY = Math.max(wall.y, Math.min(y, wall.y + wall.h));
        const dist = Math.sqrt((x - closestX)**2 + (y - closestY)**2);
        if (dist < radius) return wall;
    }
    return null;
}

function gameLoop() {
    if (!gameStarted || Object.keys(players).length === 0) return;
    
    // 敵の移動
    Object.values(enemies).forEach(enemy => {
        const target = findNearestPlayer(enemy.x, enemy.y);
        if (target) {
            const dx = target.x - enemy.x;
            const dy = target.y - enemy.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            
            if (dist > 0) {
                let newX = enemy.x + (dx / dist) * enemy.speed;
                let newY = enemy.y + (dy / dist) * enemy.speed;
                
                // 壁との衝突チェック
                if (!checkWallCollision(newX, newY, enemy.size)) {
                    enemy.x = newX;
                    enemy.y = newY;
                }
                enemy.angle = Math.atan2(dy, dx);
            }
        }
    });
    
    // Mobスポーン
    if (bossActive) {
        mobSpawnTimer++;
        if (mobSpawnTimer > 50) {
            mobSpawnTimer = 0;
            const mobCount = Math.min(2 + Math.floor(wave / 2), 5);
            for (let i = 0; i < mobCount; i++) {
                const enemy = spawnEnemy();
                io.emit('enemySpawn', enemy);
            }
        }
    }
    
    io.emit('gameSync', { enemies, items });
}

setInterval(gameLoop, 50);

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    const colorIndex = Object.keys(players).length % PLAYER_COLORS.length;
    players[socket.id] = {
        id: socket.id,
        name: 'Player' + (Object.keys(players).length + 1),
        x: WORLD_W / 2 + (Math.random() - 0.5) * 100,
        y: WORLD_H / 2 + (Math.random() - 0.5) * 100,
        angle: -Math.PI / 2,
        color: PLAYER_COLORS[colorIndex],
        hp: 100, maxHp: 100, score: 0,
        power: 1, bombs: 3, options: 0,
        weapon: 'NORMAL', unlockedWeapons: ['NORMAL'],
        formation: 'FOLLOW', dashing: false, isHost: false, ready: false
    };
    
    if (!hostId) {
        hostId = socket.id;
        players[socket.id].isHost = true;
    }
    
    socket.emit('init', {
        myId: socket.id, players, enemies, items, walls, wave,
        isHost: socket.id === hostId, gameStarted,
        worldSize: { w: WORLD_W, h: WORLD_H }
    });
    
    socket.broadcast.emit('playerJoined', players[socket.id]);
    
    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].angle = data.angle;
            players[socket.id].dashing = data.dashing || false;
            socket.broadcast.emit('playerMoved', {
                id: socket.id, x: data.x, y: data.y, angle: data.angle, dashing: data.dashing
            });
        }
    });
    
    socket.on('ready', (isReady) => {
        if (players[socket.id]) {
            players[socket.id].ready = isReady;
            io.emit('playerReady', { id: socket.id, ready: isReady });
        }
    });
    
    socket.on('setName', (name) => {
        if (players[socket.id]) {
            players[socket.id].name = name.substring(0, 12) || 'Player';
            io.emit('playerNameChanged', { id: socket.id, name: players[socket.id].name });
        }
    });
    
    socket.on('startGame', () => {
        if (socket.id === hostId && !gameStarted) {
            gameStarted = true;
            wave = 1;
            enemies = {};
            items = [];
            bossActive = false;
            mobSpawnTimer = 0;
            
            Object.values(players).forEach(p => {
                p.hp = 100; p.score = 0; p.power = 1; p.bombs = 3; p.options = 0;
                p.weapon = 'NORMAL'; p.unlockedWeapons = ['NORMAL'];
                p.x = WORLD_W / 2 + (Math.random() - 0.5) * 100;
                p.y = WORLD_H / 2 + (Math.random() - 0.5) * 100;
            });
            
            walls = generateWalls();
            io.emit('gameStarted', { wave, walls, players });
            
            setTimeout(() => { if (gameStarted) spawnBoss(); }, 3000);
        }
    });
    
    socket.on('shoot', (bulletData) => {
        io.emit('bulletFired', {
            ...bulletData,
            ownerId: socket.id,
            color: bulletData.color || players[socket.id]?.color || '#fff'
        });
    });
    
    socket.on('hitEnemy', (data) => {
        const enemy = enemies[data.enemyId];
        if (!enemy) return;
        
        enemy.hp -= (data.damage || 1);
        
        if (enemy.hp <= 0) {
            const isBoss = enemy.isBoss;
            
            if (isBoss) {
                for (let i = 0; i < 7; i++) {
                    const angle = (i / 7) * Math.PI * 2;
                    const item = spawnItem(enemy.x + Math.cos(angle) * 60, enemy.y + Math.sin(angle) * 60);
                    io.emit('itemSpawn', item);
                }
            } else if (Math.random() < 0.18) {
                const item = spawnItem(enemy.x, enemy.y);
                io.emit('itemSpawn', item);
            }
            
            if (players[socket.id]) {
                players[socket.id].score += isBoss ? 1000 * wave : 100;
                io.emit('scoreUpdate', { id: socket.id, score: players[socket.id].score });
            }
            
            io.emit('enemyDefeated', { id: enemy.id, x: enemy.x, y: enemy.y, isBoss });
            delete enemies[enemy.id];
            
            if (isBoss) {
                bossActive = false;
                wave++;
                io.emit('waveComplete', { wave });
                setTimeout(() => {
                    if (gameStarted && Object.keys(players).length > 0) spawnBoss();
                }, 5000);
            }
        } else {
            io.emit('enemyHit', { id: enemy.id, hp: enemy.hp });
        }
    });
    
    socket.on('useBomb', () => {
        const p = players[socket.id];
        if (p && p.bombs > 0) {
            p.bombs--;
            
            Object.values(enemies).forEach(enemy => {
                const dx = enemy.x - p.x;
                const dy = enemy.y - p.y;
                if (Math.sqrt(dx*dx + dy*dy) < 600) {
                    enemy.hp -= enemy.isBoss ? 40 : 150;
                    if (enemy.hp <= 0) {
                        io.emit('enemyDefeated', { id: enemy.id, x: enemy.x, y: enemy.y, isBoss: enemy.isBoss });
                        delete enemies[enemy.id];
                    }
                }
            });
            
            io.emit('bombUsed', { playerId: socket.id, x: p.x, y: p.y, bombs: p.bombs });
        }
    });
    
    socket.on('collectItem', (itemId) => {
        const index = items.findIndex(i => i.id === itemId);
        if (index === -1) return;
        
        const item = items[index];
        const p = players[socket.id];
        if (!p) return;
        
        items.splice(index, 1);
        
        switch (item.type) {
            case 'power': p.power = Math.min(p.power + 1, 10); break;
            case 'weapon':
                const locked = WEAPONS.filter(w => !p.unlockedWeapons.includes(w));
                if (locked.length > 0) {
                    const newW = locked[Math.floor(Math.random() * locked.length)];
                    p.unlockedWeapons.push(newW);
                    p.weapon = newW;
                    io.emit('weaponUnlocked', { playerId: socket.id, weapon: newW });
                } else {
                    p.power = Math.min(p.power + 1, 10);
                }
                break;
            case 'option': p.options = Math.min(p.options + 1, 4); break;
            case 'bomb': p.bombs = Math.min(p.bombs + 1, 5); break;
            case 'heal': p.hp = Math.min(p.hp + 30, p.maxHp); break;
        }
        
        io.emit('itemCollected', {
            itemId, playerId: socket.id, type: item.type,
            playerState: { power: p.power, bombs: p.bombs, options: p.options, hp: p.hp, weapon: p.weapon, unlockedWeapons: p.unlockedWeapons }
        });
    });
    
    socket.on('switchWeapon', (weapon) => {
        if (players[socket.id]?.unlockedWeapons.includes(weapon)) {
            players[socket.id].weapon = weapon;
            io.emit('weaponChanged', { id: socket.id, weapon });
        }
    });
    
    socket.on('changeFormation', (formation) => {
        if (players[socket.id]) {
            players[socket.id].formation = formation;
            io.emit('formationChanged', { id: socket.id, formation });
        }
    });
    
    socket.on('playerDamaged', (damage) => {
        const p = players[socket.id];
        if (p && !p.dashing) {
            p.hp -= damage;
            if (p.hp <= 0) {
                p.hp = 0;
                io.emit('playerDied', { id: socket.id });
                const alive = Object.values(players).filter(pl => pl.hp > 0);
                if (alive.length === 0) {
                    gameStarted = false;
                    io.emit('gameOver', { finalWave: wave });
                }
            } else {
                io.emit('playerHpChanged', { id: socket.id, hp: p.hp });
            }
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        const wasHost = socket.id === hostId;
        delete players[socket.id];
        
        if (wasHost) {
            const remaining = Object.keys(players);
            if (remaining.length > 0) {
                hostId = remaining[0];
                players[hostId].isHost = true;
                io.emit('hostChanged', { newHostId: hostId });
            } else {
                hostId = null;
                gameStarted = false;
            }
        }
        
        io.emit('playerLeft', socket.id);
        
        if (Object.keys(players).length === 0) {
            gameStarted = false;
            enemies = {};
            items = [];
            walls = [];
            wave = 0;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PLAZMER Server on port ${PORT}`));
