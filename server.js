const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 静的ファイル配信
app.use(express.static('public'));

// ゲーム状態
let players = {};
let enemies = {};
let items = [];
let bullets = [];
let wave = 1;
let enemyIdCounter = 0;
let gameStarted = false;
let hostId = null;

// 敵生成
function spawnEnemy() {
    const id = 'enemy_' + (enemyIdCounter++);
    const type = Math.random() < 0.3 ? 'hard' : 'fast';
    const enemy = {
        id: id,
        x: Math.random() * 700 + 50,
        y: -30,
        speed: type === 'fast' ? 3 : 1.5,
        hp: type === 'hard' ? 5 : 2,
        maxHp: type === 'hard' ? 5 : 2,
        type: type
    };
    enemies[id] = enemy;
    io.emit('newEnemy', enemy);
}

// ボス生成
function spawnBoss() {
    const id = 'boss_' + (enemyIdCounter++);
    const playerCount = Object.keys(players).length;
    const boss = {
        id: id,
        x: 400,
        y: -50,
        speed: 0.5,
        hp: 50 + (wave * 10) + (playerCount * 20),
        maxHp: 50 + (wave * 10) + (playerCount * 20),
        type: 'boss',
        isBoss: true
    };
    enemies[id] = boss;
    io.emit('newEnemy', boss);
    io.emit('bossSpawned', boss);
}

// ゲームループ
let lastEnemySpawn = Date.now();
let bossSpawned = false;

function gameLoop() {
    if (!gameStarted || Object.keys(players).length === 0) return;

    const now = Date.now();
    
    // 敵の移動
    Object.values(enemies).forEach(enemy => {
        enemy.y += enemy.speed;
        
        // 画面外に出たら削除
        if (enemy.y > 650) {
            delete enemies[enemy.id];
            io.emit('enemyRemoved', enemy.id);
        }
    });

    // 敵のスポーン（2秒ごと）
    if (now - lastEnemySpawn > 2000 && Object.keys(enemies).length < 15) {
        // ボスがいなければ通常敵をスポーン
        const hasBoss = Object.values(enemies).some(e => e.isBoss);
        if (!hasBoss) {
            spawnEnemy();
        }
        lastEnemySpawn = now;
    }

    // 敵の位置を全員に同期（100msごと）
    io.emit('enemySync', enemies);
    io.emit('itemSync', items);
}

setInterval(gameLoop, 100);

// Socket.IO 接続処理
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    // 新規プレイヤー作成
    const colors = ['#00f2ff', '#ff6600', '#00ff66', '#ff00ff'];
    const colorIndex = Object.keys(players).length % colors.length;
    
    players[socket.id] = {
        id: socket.id,
        x: 400,
        y: 500,
        color: colors[colorIndex],
        name: 'Player' + (Object.keys(players).length + 1),
        hp: 100,
        score: 0
    };

    // 最初のプレイヤーをホストに
    if (!hostId) {
        hostId = socket.id;
        players[socket.id].isHost = true;
    }

    // 現在の状態を送信
    socket.emit('init', {
        myId: socket.id,
        players: players,
        enemies: enemies,
        items: items,
        wave: wave,
        isHost: socket.id === hostId
    });

    // 他プレイヤーに通知
    socket.broadcast.emit('playerJoined', players[socket.id]);

    // プレイヤー移動
    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].angle = data.angle;
            socket.broadcast.emit('playerMoved', {
                id: socket.id,
                x: data.x,
                y: data.y,
                angle: data.angle
            });
        }
    });

    // 弾丸発射
    socket.on('shoot', (bulletData) => {
        const bullet = {
            id: 'bullet_' + Date.now() + '_' + socket.id,
            x: bulletData.x,
            y: bulletData.y,
            vx: bulletData.vx,
            vy: bulletData.vy,
            color: players[socket.id]?.color || '#fff',
            ownerId: socket.id
        };
        // 全員に送信（発射者含む）
        io.emit('bulletFired', bullet);
    });

    // 敵にダメージ
    socket.on('hitEnemy', (data) => {
        const enemy = enemies[data.enemyId];
        if (enemy) {
            enemy.hp -= data.damage || 1;
            
            if (enemy.hp <= 0) {
                // 撃破
                const dropItem = Math.random() < 0.3;
                
                io.emit('enemyDefeated', {
                    id: enemy.id,
                    x: enemy.x,
                    y: enemy.y,
                    dropItem: dropItem,
                    isBoss: enemy.isBoss
                });

                // アイテムドロップ
                if (dropItem) {
                    const item = {
                        id: 'item_' + Date.now(),
                        x: enemy.x,
                        y: enemy.y,
                        type: Math.random() < 0.5 ? 'power' : 'heal'
                    };
                    items.push(item);
                }

                // スコア加算
                if (players[socket.id]) {
                    players[socket.id].score += enemy.isBoss ? 1000 : 100;
                    io.emit('scoreUpdate', { id: socket.id, score: players[socket.id].score });
                }

                // ボス撃破時は次のWave
                if (enemy.isBoss) {
                    wave++;
                    io.emit('waveUpdate', wave);
                    setTimeout(() => spawnBoss(), 3000);
                }

                delete enemies[enemy.id];
            } else {
                // HP更新を送信
                io.emit('enemyHit', { id: enemy.id, hp: enemy.hp });
            }
        }
    });

    // アイテム取得
    socket.on('collectItem', (itemId) => {
        const index = items.findIndex(i => i.id === itemId);
        if (index !== -1) {
            const item = items[index];
            items.splice(index, 1);
            io.emit('itemCollected', { itemId: itemId, playerId: socket.id, type: item.type });
        }
    });

    // ゲーム開始
    socket.on('startGame', () => {
        if (socket.id === hostId && !gameStarted) {
            gameStarted = true;
            wave = 1;
            enemies = {};
            items = [];
            io.emit('gameStarted', { wave: wave });
            
            // 最初のボスをスポーン
            setTimeout(() => spawnBoss(), 2000);
        }
    });

    // 名前設定
    socket.on('setName', (name) => {
        if (players[socket.id]) {
            players[socket.id].name = name.substring(0, 12);
            io.emit('playerNameChanged', { id: socket.id, name: players[socket.id].name });
        }
    });

    // 切断
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        
        // ホストが抜けたら次の人をホストに
        if (socket.id === hostId) {
            delete players[socket.id];
            const remainingPlayers = Object.keys(players);
            if (remainingPlayers.length > 0) {
                hostId = remainingPlayers[0];
                players[hostId].isHost = true;
                io.emit('hostChanged', hostId);
            } else {
                hostId = null;
                gameStarted = false;
            }
        } else {
            delete players[socket.id];
        }
        
        io.emit('playerLeft', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`PLAZMER Server running on port ${PORT}`);
});
