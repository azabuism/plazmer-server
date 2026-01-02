const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static('public'));

// ========== CONSTANTS ==========
const WORLD_W = 3000, WORLD_H = 3000;
const PLAYER_COLORS = ['#00f2ff', '#ff6600', '#00ff66', '#ff00ff'];
const MAX_PLAYERS_PER_ROOM = 4;

// ========== ROOM MANAGEMENT ==========
const rooms = new Map(); // roomId -> RoomState

class RoomState {
    constructor(roomId, hostId) {
        this.roomId = roomId;
        this.hostId = hostId;
        this.players = new Map(); // odlığı -> PlayerState
        this.enemies = new Map();
        this.items = [];
        this.walls = [];
        this.wave = 0;
        this.gameStarted = false;
        this.enemyIdCounter = 0;
        this.itemIdCounter = 0;
        this.bossActive = false;
        this.currentBoss = null;
        this.mobSpawnTimer = 0;
        this.waveTimer = 0;
    }
}

class PlayerState {
    constructor(id, name, color, isHost) {
        this.id = id;
        this.name = name;
        this.color = color;
        this.isHost = isHost;
        this.ready = isHost; // Host is always ready
        this.x = WORLD_W / 2 + (Math.random() - 0.5) * 100;
        this.y = WORLD_H / 2 + (Math.random() - 0.5) * 100;
        this.angle = -Math.PI / 2;
        this.hp = 100;
        this.maxHp = 100;
        this.score = 0;
        this.dashing = false;
    }
}

// ========== HELPER FUNCTIONS ==========
function generateRoomId() {
    let id;
    do {
        id = String(Math.floor(1000 + Math.random() * 9000));
    } while (rooms.has(id));
    return id;
}

function generateWalls(wave) {
    const walls = [];
    const sz = 250;
    const rng = () => Math.random();
    
    // Border walls
    walls.push({ x: -50, y: -50, w: WORLD_W + 100, h: 50 });
    walls.push({ x: -50, y: WORLD_H, w: WORLD_W + 100, h: 50 });
    walls.push({ x: -50, y: 0, w: 50, h: WORLD_H });
    walls.push({ x: WORLD_W, y: 0, w: 50, h: WORLD_H });
    
    // Random interior walls
    for (let x = 0; x < WORLD_W; x += sz) {
        for (let y = 0; y < WORLD_H; y += sz) {
            // Keep center clear for spawn
            if (Math.hypot(x - WORLD_W / 2, y - WORLD_H / 2) < 400) continue;
            if (rng() < 0.15 + wave * 0.01) {
                walls.push({ x: x + 20, y: y + 20, w: sz - 40, h: sz - 40 });
            }
        }
    }
    
    return walls;
}

function checkWallCollision(walls, x, y, radius = 0) {
    for (const w of walls) {
        if (x + radius > w.x && x - radius < w.x + w.w &&
            y + radius > w.y && y - radius < w.y + w.h) {
            return true;
        }
    }
    return false;
}

function findSpawnPosition(room, minDistFromPlayers = 400) {
    for (let attempt = 0; attempt < 50; attempt++) {
        const x = 200 + Math.random() * (WORLD_W - 400);
        const y = 200 + Math.random() * (WORLD_H - 400);
        
        if (checkWallCollision(room.walls, x, y, 50)) continue;
        
        let tooClose = false;
        for (const [, player] of room.players) {
            if (Math.hypot(player.x - x, player.y - y) < minDistFromPlayers) {
                tooClose = true;
                break;
            }
        }
        
        if (!tooClose) return { x, y };
    }
    
    // Fallback to corners
    const corners = [
        { x: 300, y: 300 },
        { x: WORLD_W - 300, y: 300 },
        { x: 300, y: WORLD_H - 300 },
        { x: WORLD_W - 300, y: WORLD_H - 300 }
    ];
    return corners[Math.floor(Math.random() * corners.length)];
}

// ========== ENEMY TYPES ==========
const ENEMY_TYPES = {
    slime: { hp: 3, speed: 1.5, size: 12, color: '#00ff00', score: 50, name: 'CELL' },
    bat: { hp: 2, speed: 3, size: 10, color: '#00ffff', score: 60, name: 'DRONE' },
    skull: { hp: 10, speed: 1.8, size: 18, color: '#ffffff', score: 150, name: 'SENTRY', shoots: true },
    ghost: { hp: 15, speed: 2, size: 20, color: '#ff88ff', score: 180, name: 'PHASE' },
    knight: { hp: 30, speed: 1.5, size: 25, color: '#ffaa00', score: 300, name: 'GUARD', shielded: true },
    dragon: { hp: 60, speed: 2, size: 35, color: '#ff4400', score: 500, name: 'BLASTER', shoots: true },
    golem: { hp: 100, speed: 0.8, size: 45, color: '#cc9966', score: 600, name: 'TANK' }
};

const BOSS_TYPES = [
    { name: 'CORE-α', color: '#ff0000', baseHp: 300, size: 60 },
    { name: 'MATRIX-β', color: '#0088ff', baseHp: 500, size: 70 },
    { name: 'REACTOR-γ', color: '#00ff44', baseHp: 700, size: 80 },
    { name: 'NEXUS-δ', color: '#ff00ff', baseHp: 900, size: 90 },
    { name: 'OMEGA-Ω', color: '#ffff00', baseHp: 1200, size: 100 }
];

function createEnemy(room, type, x, y) {
    const template = ENEMY_TYPES[type];
    const waveScale = 1 + room.wave * 0.1;
    
    const enemy = {
        id: 'enemy_' + (room.enemyIdCounter++),
        type,
        x, y,
        hp: Math.floor(template.hp * waveScale),
        maxHp: Math.floor(template.hp * waveScale),
        speed: template.speed,
        size: template.size,
        color: template.color,
        score: template.score,
        name: template.name,
        shoots: template.shoots || false,
        shielded: template.shielded || false,
        isBoss: false,
        timer: 0,
        frozen: 0,
        burning: 0
    };
    
    room.enemies.set(enemy.id, enemy);
    return enemy;
}

function createBoss(room) {
    const bossIndex = (room.wave - 1) % BOSS_TYPES.length;
    const template = BOSS_TYPES[bossIndex];
    const playerCount = room.players.size;
    const waveScale = 1 + Math.floor((room.wave - 1) / 5) * 0.5;
    const multiScale = 1 + (playerCount - 1) * 0.5;
    
    const pos = findSpawnPosition(room, 600);
    
    const boss = {
        id: 'boss_' + (room.enemyIdCounter++),
        type: 'boss',
        bossType: bossIndex,
        x: pos.x,
        y: pos.y,
        hp: Math.floor((template.baseHp + room.wave * 30) * waveScale * multiScale),
        maxHp: Math.floor((template.baseHp + room.wave * 30) * waveScale * multiScale),
        speed: 1.2 - bossIndex * 0.1,
        size: template.size + room.wave * 2,
        color: template.color,
        score: 3000 + room.wave * 500,
        name: template.name,
        isBoss: true,
        timer: 0,
        attackTimer: 0,
        frozen: 0,
        burning: 0
    };
    
    room.enemies.set(boss.id, boss);
    room.currentBoss = boss;
    room.bossActive = true;
    
    return boss;
}

function spawnMob(room) {
    if (!room.bossActive) return null;
    
    const mobCount = Array.from(room.enemies.values()).filter(e => !e.isBoss).length;
    if (mobCount >= 30) return null;
    
    const pos = findSpawnPosition(room, 300);
    
    const types = ['slime', 'bat'];
    if (room.wave >= 3) types.push('skull', 'ghost');
    if (room.wave >= 5) types.push('knight');
    if (room.wave >= 7) types.push('dragon');
    
    const type = types[Math.floor(Math.random() * types.length)];
    return createEnemy(room, type, pos.x, pos.y);
}

// ========== ITEM TYPES ==========
const ITEM_TYPES = {
    N: { color: '#ffff00', name: 'NORMAL' },
    S: { color: '#ff5555', name: 'SPREAD' },
    P: { color: '#00ffff', name: 'LASER' },
    M: { color: '#aa00ff', name: 'MISSILE' },
    R: { color: '#0088ff', name: 'REFLECT' },
    F: { color: '#ff8800', name: 'FLAME' },
    Z: { color: '#88ffff', name: 'FREEZE' },
    T: { color: '#ffff00', name: 'THUNDER' },
    X: { color: '#ff00ff', name: 'PLASMA' },
    B: { color: '#ff8800', name: 'BOOMERANG' },
    O: { color: '#00ff00', name: 'OPTION' },
    C: { color: '#00ffff', name: 'CHAIN' },
    H: { color: '#ff0066', name: 'HEAL' }, // Heart
    SABER: { color: '#00ff88', name: 'SABER' },
    RAIL: { color: '#ff00aa', name: 'RAILGUN' }
};

function spawnItem(room, x, y, type) {
    const item = {
        id: 'item_' + (room.itemIdCounter++),
        x, y,
        type,
        color: ITEM_TYPES[type]?.color || '#fff'
    };
    room.items.push(item);
    return item;
}

function dropItems(room, x, y, isBoss) {
    const items = [];
    
    if (isBoss) {
        // Boss drops 3-5 items
        const dropCount = 3 + Math.floor(Math.random() * 3);
        const types = ['S', 'P', 'M', 'R', 'F', 'Z', 'T', 'X', 'O', 'C', 'B', 'SABER', 'RAIL'];
        
        for (let i = 0; i < dropCount; i++) {
            const angle = (Math.PI * 2 / dropCount) * i;
            const type = types[Math.floor(Math.random() * types.length)];
            items.push(spawnItem(room, x + Math.cos(angle) * 50, y + Math.sin(angle) * 50, type));
        }
    } else {
        // Regular enemy drops
        if (Math.random() < 0.08) {
            const types = ['N', 'S', 'P', 'M', 'R', 'F', 'Z', 'T', 'X', 'B'];
            items.push(spawnItem(room, x, y, types[Math.floor(Math.random() * types.length)]));
        }
        if (Math.random() < 0.03) {
            items.push(spawnItem(room, x + 20, y, 'H'));
        }
        if (Math.random() < 0.02) {
            const bonus = ['O', 'C', 'SABER', 'RAIL'];
            items.push(spawnItem(room, x - 20, y, bonus[Math.floor(Math.random() * bonus.length)]));
        }
    }
    
    return items;
}

// ========== GAME LOOP ==========
function updateRoom(room) {
    if (!room.gameStarted) return;
    
    room.waveTimer++;
    room.mobSpawnTimer++;
    
    // Start first wave
    if (room.wave === 0 && room.waveTimer > 60) {
        startWave(room);
    }
    
    // Spawn mobs during boss fight
    if (room.bossActive && room.mobSpawnTimer >= 60) {
        room.mobSpawnTimer = 0;
        const spawnCount = Math.min(3, 1 + Math.floor(room.wave / 3));
        for (let i = 0; i < spawnCount; i++) {
            const mob = spawnMob(room);
            if (mob) {
                io.to(room.roomId).emit('enemySpawn', mob);
            }
        }
    }
    
    // Update enemies
    for (const [, enemy] of room.enemies) {
        updateEnemy(room, enemy);
    }
    
    // Sync to clients
    if (room.waveTimer % 3 === 0) {
        const enemyData = Array.from(room.enemies.values()).map(e => ({
            id: e.id,
            x: e.x,
            y: e.y,
            hp: e.hp,
            maxHp: e.maxHp,
            frozen: e.frozen,
            burning: e.burning
        }));
        io.to(room.roomId).emit('gameSync', { enemies: enemyData, items: room.items });
    }
}

function updateEnemy(room, enemy) {
    if (enemy.hp <= 0) return;
    
    enemy.timer++;
    
    // Status effects
    if (enemy.burning > 0) {
        enemy.burning--;
        if (enemy.timer % 20 === 0) {
            enemy.hp -= 1;
        }
    }
    
    // Find nearest player
    let nearestPlayer = null;
    let minDist = Infinity;
    
    for (const [, player] of room.players) {
        if (player.hp <= 0) continue;
        const dist = Math.hypot(player.x - enemy.x, player.y - enemy.y);
        if (dist < minDist) {
            minDist = dist;
            nearestPlayer = player;
        }
    }
    
    if (!nearestPlayer) return;
    
    // Movement
    const speed = enemy.frozen > 0 ? enemy.speed * 0.3 : enemy.speed;
    if (enemy.frozen > 0) enemy.frozen--;
    
    const angle = Math.atan2(nearestPlayer.y - enemy.y, nearestPlayer.x - enemy.x);
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    
    if (!checkWallCollision(room.walls, enemy.x + vx, enemy.y + vy, enemy.size)) {
        enemy.x += vx;
        enemy.y += vy;
    }
    
    // Collision with player
    if (minDist < enemy.size + 15 && !nearestPlayer.dashing) {
        io.to(room.roomId).emit('playerDamage', {
            playerId: nearestPlayer.id,
            damage: enemy.isBoss ? 20 : 10
        });
    }
    
    // Boss attacks
    if (enemy.isBoss) {
        enemy.attackTimer++;
        executeBossAttack(room, enemy, nearestPlayer);
    }
    
    // Shooting enemies
    if (enemy.shoots && enemy.timer % 90 === 0) {
        io.to(room.roomId).emit('enemyShoot', {
            x: enemy.x,
            y: enemy.y,
            angle: angle,
            speed: 5
        });
    }
}

function executeBossAttack(room, boss, target) {
    const attacks = [];
    
    switch (boss.bossType) {
        case 0: // CORE-α - Radial bursts
            if (boss.attackTimer % 90 === 0) {
                for (let i = 0; i < 16; i++) {
                    const a = (Math.PI * 2 / 16) * i;
                    attacks.push({ x: boss.x, y: boss.y, vx: Math.cos(a) * 4, vy: Math.sin(a) * 4 });
                }
            }
            break;
            
        case 1: // MATRIX-β - Spiral
            if (boss.attackTimer % 60 === 0) {
                for (let i = 0; i < 8; i++) {
                    const a = (Math.PI * 2 / 8) * i + boss.timer * 0.02;
                    attacks.push({ x: boss.x, y: boss.y, vx: Math.cos(a) * 5, vy: Math.sin(a) * 5 });
                }
            }
            break;
            
        case 2: // REACTOR-γ - Ground pound
            if (boss.attackTimer % 120 === 0) {
                for (let i = 0; i < 24; i++) {
                    const a = (Math.PI * 2 / 24) * i;
                    attacks.push({ x: boss.x, y: boss.y, vx: Math.cos(a) * 6, vy: Math.sin(a) * 6, size: 10 });
                }
                io.to(room.roomId).emit('screenShake', 20);
            }
            break;
            
        case 3: // NEXUS-δ - Double spiral
            if (boss.attackTimer % 10 === 0) {
                const a = boss.timer * 0.15;
                attacks.push({ x: boss.x, y: boss.y, vx: Math.cos(a) * 5, vy: Math.sin(a) * 5, color: '#f0f' });
                attacks.push({ x: boss.x, y: boss.y, vx: Math.cos(a + Math.PI) * 5, vy: Math.sin(a + Math.PI) * 5, color: '#f0f' });
            }
            break;
            
        case 4: // OMEGA-Ω - Everything
            if (boss.attackTimer % 8 === 0) {
                const a = boss.timer * 0.1;
                for (let i = 0; i < 4; i++) {
                    const aa = a + (Math.PI / 2) * i;
                    attacks.push({ x: boss.x, y: boss.y, vx: Math.cos(aa) * 4, vy: Math.sin(aa) * 4, color: '#ff0' });
                }
            }
            if (boss.attackTimer % 120 === 0) {
                for (let i = 0; i < 32; i++) {
                    const a = (Math.PI * 2 / 32) * i;
                    attacks.push({ x: boss.x, y: boss.y, vx: Math.cos(a) * 5, vy: Math.sin(a) * 5 });
                }
                io.to(room.roomId).emit('screenShake', 25);
            }
            break;
    }
    
    if (attacks.length > 0) {
        io.to(room.roomId).emit('enemyBullets', attacks);
    }
}

function startWave(room) {
    room.wave++;
    room.waveTimer = 0;
    room.walls = generateWalls(room.wave);
    
    io.to(room.roomId).emit('waveStart', {
        wave: room.wave,
        walls: room.walls
    });
    
    // Spawn boss after delay
    setTimeout(() => {
        if (room.gameStarted) {
            const boss = createBoss(room);
            io.to(room.roomId).emit('bossSpawn', boss);
        }
    }, 1500);
}

function damageEnemy(room, enemyId, damage, weaponType, attackerId) {
    const enemy = room.enemies.get(enemyId);
    if (!enemy || enemy.hp <= 0) return;
    
    // Shield reduction
    if (enemy.shielded && weaponType !== 'FLAME' && weaponType !== 'THUNDER') {
        damage = Math.floor(damage / 2);
    }
    
    // Freeze bonus
    if (weaponType === 'FREEZE' && enemy.type === 'golem') {
        damage *= 2;
    }
    
    enemy.hp -= damage;
    
    io.to(room.roomId).emit('enemyHit', {
        id: enemyId,
        damage,
        hp: enemy.hp,
        maxHp: enemy.maxHp
    });
    
    if (enemy.hp <= 0) {
        const items = dropItems(room, enemy.x, enemy.y, enemy.isBoss);
        
        io.to(room.roomId).emit('enemyDefeated', {
            id: enemyId,
            x: enemy.x,
            y: enemy.y,
            isBoss: enemy.isBoss,
            score: enemy.score,
            items
        });
        
        room.enemies.delete(enemyId);
        
        // Update attacker score
        const attacker = room.players.get(attackerId);
        if (attacker) {
            attacker.score += enemy.score;
            io.to(room.roomId).emit('scoreUpdate', {
                playerId: attackerId,
                score: attacker.score
            });
        }
        
        // Boss defeated
        if (enemy.isBoss) {
            room.bossActive = false;
            room.currentBoss = null;
            
            // Clear remaining mobs
            for (const [id, e] of room.enemies) {
                if (!e.isBoss) {
                    io.to(room.roomId).emit('enemyDefeated', { id, x: e.x, y: e.y, isBoss: false, score: 0, items: [] });
                    room.enemies.delete(id);
                }
            }
            
            io.to(room.roomId).emit('bossDefeated', { wave: room.wave });
            
            // Next wave after delay
            setTimeout(() => {
                if (room.gameStarted) {
                    startWave(room);
                }
            }, 3000);
        }
    }
}

// Game loop interval
setInterval(() => {
    for (const [, room] of rooms) {
        updateRoom(room);
    }
}, 50);

// ========== SOCKET HANDLERS ==========
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    let currentRoom = null;
    
    // Create room
    socket.on('createRoom', (data) => {
        const roomId = generateRoomId();
        const room = new RoomState(roomId, socket.id);
        const player = new PlayerState(socket.id, data.name || 'Host', PLAYER_COLORS[0], true);
        
        room.players.set(socket.id, player);
        rooms.set(roomId, room);
        currentRoom = room;
        
        socket.join(roomId);
        
        socket.emit('roomCreated', {
            roomId,
            playerId: socket.id,
            players: Array.from(room.players.values())
        });
        
        console.log(`Room ${roomId} created by ${socket.id}`);
    });
    
    // Join room
    socket.on('joinRoom', (data) => {
        const room = rooms.get(data.roomId);
        
        if (!room) {
            socket.emit('joinError', 'Room not found');
            return;
        }
        
        if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
            socket.emit('joinError', 'Room is full');
            return;
        }
        
        if (room.gameStarted) {
            socket.emit('joinError', 'Game already started');
            return;
        }
        
        const colorIndex = room.players.size % PLAYER_COLORS.length;
        const player = new PlayerState(socket.id, data.name || 'Player', PLAYER_COLORS[colorIndex], false);
        
        room.players.set(socket.id, player);
        currentRoom = room;
        
        socket.join(data.roomId);
        
        socket.emit('roomJoined', {
            roomId: data.roomId,
            playerId: socket.id,
            players: Array.from(room.players.values()),
            hostId: room.hostId
        });
        
        socket.to(data.roomId).emit('playerJoined', player);
        
        console.log(`Player ${socket.id} joined room ${data.roomId}`);
    });
    
    // Ready toggle
    socket.on('toggleReady', () => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (player && !player.isHost) {
            player.ready = !player.ready;
            io.to(currentRoom.roomId).emit('playerReady', {
                playerId: socket.id,
                ready: player.ready
            });
        }
    });
    
    // Start game (host only)
    socket.on('startGame', () => {
        if (!currentRoom || currentRoom.hostId !== socket.id) return;
        
        currentRoom.gameStarted = true;
        currentRoom.wave = 0;
        currentRoom.waveTimer = 0;
        currentRoom.walls = generateWalls(0);
        
        // Reset all players
        for (const [, player] of currentRoom.players) {
            player.hp = 100;
            player.score = 0;
            player.x = WORLD_W / 2 + (Math.random() - 0.5) * 100;
            player.y = WORLD_H / 2 + (Math.random() - 0.5) * 100;
        }
        
        io.to(currentRoom.roomId).emit('gameStarted', {
            players: Array.from(currentRoom.players.values()),
            walls: currentRoom.walls,
            worldSize: { w: WORLD_W, h: WORLD_H }
        });
        
        console.log(`Game started in room ${currentRoom.roomId}`);
    });
    
    // Player movement
    socket.on('move', (data) => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (player) {
            player.x = data.x;
            player.y = data.y;
            player.angle = data.angle;
            player.dashing = data.dashing || false;
            
            socket.to(currentRoom.roomId).emit('playerMoved', {
                playerId: socket.id,
                x: data.x,
                y: data.y,
                angle: data.angle,
                dashing: data.dashing
            });
        }
    });
    
    // Bullet fired
    socket.on('shoot', (bulletData) => {
        if (!currentRoom) return;
        socket.to(currentRoom.roomId).emit('bulletFired', {
            ...bulletData,
            ownerId: socket.id
        });
    });
    
    // Hit enemy
    socket.on('hitEnemy', (data) => {
        if (!currentRoom) return;
        damageEnemy(currentRoom, data.enemyId, data.damage, data.weaponType, socket.id);
    });
    
    // Collect item
    socket.on('collectItem', (itemId) => {
        if (!currentRoom) return;
        const index = currentRoom.items.findIndex(i => i.id === itemId);
        if (index !== -1) {
            const item = currentRoom.items[index];
            currentRoom.items.splice(index, 1);
            
            io.to(currentRoom.roomId).emit('itemCollected', {
                itemId,
                playerId: socket.id,
                type: item.type
            });
        }
    });
    
    // Use bomb
    socket.on('useBomb', (data) => {
        if (!currentRoom) return;
        
        // Damage all enemies in range
        for (const [, enemy] of currentRoom.enemies) {
            const dist = Math.hypot(enemy.x - data.x, enemy.y - data.y);
            if (dist < 600) {
                damageEnemy(currentRoom, enemy.id, 80, 'BOMB', socket.id);
            }
        }
        
        io.to(currentRoom.roomId).emit('bombUsed', {
            playerId: socket.id,
            x: data.x,
            y: data.y
        });
    });
    
    // Player damaged
    socket.on('playerDamaged', (data) => {
        if (!currentRoom) return;
        const player = currentRoom.players.get(socket.id);
        if (player) {
            player.hp -= data.damage;
            
            io.to(currentRoom.roomId).emit('playerHpChanged', {
                playerId: socket.id,
                hp: player.hp
            });
            
            if (player.hp <= 0) {
                // Check if all players dead
                const allDead = Array.from(currentRoom.players.values()).every(p => p.hp <= 0);
                
                if (allDead) {
                    currentRoom.gameStarted = false;
                    io.to(currentRoom.roomId).emit('gameOver', {
                        finalWave: currentRoom.wave
                    });
                } else {
                    // Respawn
                    player.hp = 50;
                    player.x = WORLD_W / 2;
                    player.y = WORLD_H / 2;
                    
                    io.to(currentRoom.roomId).emit('playerRespawn', {
                        playerId: socket.id,
                        x: player.x,
                        y: player.y,
                        hp: player.hp
                    });
                }
            }
        }
    });
    
    // Leave room
    socket.on('leaveRoom', () => {
        handleDisconnect();
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        handleDisconnect();
        console.log('Player disconnected:', socket.id);
    });
    
    function handleDisconnect() {
        if (!currentRoom) return;
        
        currentRoom.players.delete(socket.id);
        socket.leave(currentRoom.roomId);
        
        if (currentRoom.players.size === 0) {
            // Delete empty room
            rooms.delete(currentRoom.roomId);
            console.log(`Room ${currentRoom.roomId} deleted (empty)`);
        } else {
            // Transfer host if needed
            if (currentRoom.hostId === socket.id) {
                const newHost = currentRoom.players.keys().next().value;
                currentRoom.hostId = newHost;
                const hostPlayer = currentRoom.players.get(newHost);
                if (hostPlayer) {
                    hostPlayer.isHost = true;
                    hostPlayer.ready = true;
                }
                
                io.to(currentRoom.roomId).emit('hostChanged', { newHostId: newHost });
            }
            
            io.to(currentRoom.roomId).emit('playerLeft', socket.id);
        }
        
        currentRoom = null;
    }
});

// ========== SERVER START ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`PLAZMER Server running on port ${PORT}`);
});
