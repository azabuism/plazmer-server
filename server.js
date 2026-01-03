const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ========== 定数・設定 ==========
const WORLD_W = 3000, WORLD_H = 3000;
const FPS = 30; // 通信負荷軽減のため30FPSで計算（クライアントは補間して60FPSに見せる）

// ゲームルーム管理
const rooms = {}; // roomId -> RoomObject

class Room {
    constructor(id) {
        this.id = id;
        this.players = {}; // socketId -> Player
        this.enemies = [];
        this.bullets = []; // プレイヤーの弾
        this.enemyBullets = [];
        this.items = [];
        this.walls = generateMazeWalls(0);
        this.wave = 0;
        this.waveTimer = 0;
        this.bossActive = false;
        this.enemyIdCounter = 0;
    }
}

// ========== ゲームロジック (サーバー側で計算) ==========

// 迷路生成（シングルプレイと同じロジック）
function generateMazeWalls(waveNum) {
    const w = [];
    const thickness = 50;
    w.push({ x: 0, y: 0, w: WORLD_W, h: thickness, type: 'border' });
    w.push({ x: 0, y: WORLD_H - thickness, w: WORLD_W, h: thickness, type: 'border' });
    w.push({ x: 0, y: 0, w: thickness, h: WORLD_H, type: 'border' });
    w.push({ x: WORLD_W - thickness, y: 0, w: thickness, h: WORLD_H, type: 'border' });
    
    // 簡易的な障害物（通信量削減のため少し減らす）
    const gridSize = 400;
    for (let x = gridSize; x < WORLD_W - gridSize; x += gridSize) {
        for (let y = gridSize; y < WORLD_H - gridSize; y += gridSize) {
            if (Math.random() < 0.3) {
                w.push({
                    x: x, y: y, w: 60, h: 60, type: 'cell',
                    cx: x + 30, cy: y + 30, radius: 30
                });
            }
        }
    }
    return w;
}

function checkWall(x, y, walls) {
    for (const w of walls) {
        if (w.type === 'cell') {
            if (Math.hypot(x - w.cx, y - w.cy) < w.radius) return true;
        } else {
            if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true;
        }
    }
    return false;
}

// マクロスミサイルクラス (サーバー版)
class MacrossMissile {
    constructor(ownerId, x, y, angle) {
        this.ownerId = ownerId;
        this.x = x; this.y = y;
        const spreadAngle = angle + (Math.random() - 0.5) * Math.PI; // ランダム拡散
        const speed = 15 + Math.random() * 10; // 初速
        this.vx = Math.cos(spreadAngle) * speed;
        this.vy = Math.sin(spreadAngle) * speed;
        this.life = 150;
        this.phase = 0; // 0:拡散, 1:誘導
        this.timer = 0;
        this.waitTime = 5 + Math.random() * 10;
        this.damage = 15;
    }

    update(room) {
        this.timer++;
        this.life--;

        if (this.phase === 0) {
            this.x += this.vx; this.y += this.vy;
            this.vx *= 0.9; this.vy *= 0.9; // 減速
            if (this.timer > this.waitTime) this.phase = 1;
        } else {
            // 最寄りの敵を探す
            let target = null, minDist = 1200;
            for (const e of room.enemies) {
                const d = Math.hypot(e.x - this.x, e.y - this.y);
                if (d < minDist) { minDist = d; target = e; }
            }

            if (target) {
                const desiredAngle = Math.atan2(target.y - this.y, target.x - this.x);
                const currentAngle = Math.atan2(this.vy, this.vx);
                let delta = desiredAngle - currentAngle;
                while (delta < -Math.PI) delta += Math.PI * 2;
                while (delta > Math.PI) delta -= Math.PI * 2;
                
                // 誘導性能
                const turnSpeed = 0.5;
                const newAngle = currentAngle + Math.max(-turnSpeed, Math.min(turnSpeed, delta));
                const speed = 25; // 誘導後の最高速度
                
                this.vx = Math.cos(newAngle) * speed;
                this.vy = Math.sin(newAngle) * speed;
            }
            this.x += this.vx; this.y += this.vy;
        }
        
        // 壁判定（簡易）
        if (checkWall(this.x, this.y, room.walls)) this.life = 0;
    }
}

// ========== Socket.IO イベント ==========

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    // ルーム参加・作成
    let currentRoomId = 'public_room'; // とりあえず1つのルームに集める
    socket.join(currentRoomId);

    if (!rooms[currentRoomId]) {
        rooms[currentRoomId] = new Room(currentRoomId);
        console.log('Room created:', currentRoomId);
    }
    const room = rooms[currentRoomId];

    // プレイヤー生成
    room.players[socket.id] = {
        id: socket.id,
        x: WORLD_W / 2 + (Math.random()-0.5)*200,
        y: WORLD_H / 2 + (Math.random()-0.5)*200,
        angle: 0,
        hp: 100, maxHp: 100,
        score: 0,
        dashing: false,
        dashTimer: 0,
        formation: 0, // 0:Follow, 1:AllRange
        input: { x: 0, y: 0, active: false }
    };

    // クライアントへ初期データ送信
    socket.emit('init', {
        id: socket.id,
        walls: room.walls,
        worldW: WORLD_W, worldH: WORLD_H
    });

    // 入力受信 (マウス座標、クリック状態)
    socket.on('input', (data) => {
        const p = room.players[socket.id];
        if (p) {
            p.input = data; // { targetX, targetY, isClicking, dashPressed, changeForm }
            
            // フォーメーション変更リクエスト
            if (data.changeForm) {
                p.formation = (p.formation + 1) % 2; // Follow <-> Hunt 切り替え
            }
            // ダッシュリクエスト
            if (data.dashPressed && p.dashTimer <= -30) { // クールダウン
                p.dashing = true;
                p.dashTimer = 10; // ダッシュ持続時間
            }
        }
    });

    socket.on('disconnect', () => {
        delete room.players[socket.id];
        console.log('Player disconnected:', socket.id);
    });
});

// ========== メインゲームループ (30FPS) ==========
setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        updateGame(room);
        
        // クライアントへの全体同期データ作成
        const pack = {
            players: room.players,
            enemies: room.enemies.map(e => ({
                id: e.id, x: Math.round(e.x), y: Math.round(e.y), 
                type: e.type, hp: e.hp, maxHp: e.maxHp, size: e.size, color: e.color
            })),
            bullets: room.bullets.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), color: b.color || '#fff' })),
            wave: room.wave
        };
        
        io.to(roomId).emit('state', pack);
    }
}, 1000 / FPS);

function updateGame(room) {
    // 1. プレイヤー更新
    for (const id in room.players) {
        const p = room.players[id];
        
        // 角度計算 (PC: マウス追従)
        p.angle = Math.atan2(p.input.targetY - p.y, p.input.targetX - p.x);

        // 移動処理
        let speed = 8;
        let vx = 0, vy = 0;

        if (p.dashing) {
            // DASH中: 壁抜け & 高速移動
            speed = 35;
            vx = Math.cos(p.angle) * speed;
            vy = Math.sin(p.angle) * speed;
            p.dashTimer--;
            if (p.dashTimer <= 0) p.dashing = false;
        } else {
            // 通常移動: マウスに向かって進む
            p.dashTimer--; // クールダウン用
            const dist = Math.hypot(p.input.targetX - p.x, p.input.targetY - p.y);
            if (dist > 20) {
                vx = Math.cos(p.angle) * speed;
                vy = Math.sin(p.angle) * speed;
                
                // 壁判定 (DASH中でなければ)
                if (checkWall(p.x + vx, p.y + vy, room.walls)) {
                    vx = 0; vy = 0; // 簡易的に止める
                }
            }
        }

        p.x += vx;
        p.y += vy;
        p.x = Math.max(50, Math.min(WORLD_W - 50, p.x));
        p.y = Math.max(50, Math.min(WORLD_H - 50, p.y));

        // 攻撃処理 (自動発射 or クリック長押し。ここでは自動発射にする)
        if (Date.now() % 200 < 20) { // 簡易タイマー
            // 360度プラズマー (簡易版)
            // マクロスミサイル発射
            if (p.formation === 1) { // ALL RANGE (HUNT)
                 // オプション攻撃ロジックは省略し、本体からミサイル大量発射
                 for(let i=0; i<3; i++) {
                     room.bullets.push(new MacrossMissile(p.id, p.x, p.y, p.angle));
                 }
            } else {
                // 通常ショット
                room.bullets.push({ 
                    x: p.x, y: p.y, vx: Math.cos(p.angle)*20, vy: Math.sin(p.angle)*20, 
                    life: 50, damage: 10, type: 'PLAZMER', ownerId: p.id 
                });
            }
        }
    }

    // 2. 弾の更新
    for (let i = room.bullets.length - 1; i >= 0; i--) {
        const b = room.bullets[i];
        if (b instanceof MacrossMissile) {
            b.update(room);
        } else {
            b.x += b.vx; b.y += b.vy; b.life--;
        }

        // 当たり判定
        let hit = false;
        for (const e of room.enemies) {
            if (Math.hypot(e.x - b.x, e.y - b.y) < e.size + 10) {
                e.hp -= b.damage || 10;
                hit = true;
                break;
            }
        }
        
        if (b.life <= 0 || hit || (b.type && checkWall(b.x, b.y, room.walls))) {
            room.bullets.splice(i, 1);
        }
    }

    // 3. 敵の更新 & 生成 (簡易版)
    if (room.enemies.length < 30 + room.wave * 2) {
        if (Math.random() < 0.1) spawnEnemy(room);
    }

    for (let i = room.enemies.length - 1; i >= 0; i--) {
        const e = room.enemies[i];
        
        // 最寄りのプレイヤーを探して追尾
        let target = null, minDist = 9999;
        for(const pid in room.players) {
            const p = room.players[pid];
            const d = Math.hypot(p.x - e.x, p.y - e.y);
            if(d < minDist) { minDist = d; target = p; }
        }

        if (target) {
            const angle = Math.atan2(target.y - e.y, target.x - e.x);
            e.x += Math.cos(angle) * e.speed;
            e.y += Math.sin(angle) * e.speed;
        }

        if (e.hp <= 0) {
            // 撃破
            if(room.players[e.targetId]) room.players[e.targetId].score += 100;
            room.enemies.splice(i, 1);
        }
    }
}

function spawnEnemy(room) {
    const type = Math.random() < 0.1 && room.wave > 3 ? 'BOSS' : 'MOB';
    const scale = room.wave > 20 ? 5 : 1; // 20WAVE以降の強化
    
    room.enemies.push({
        id: room.enemyIdCounter++,
        x: Math.random() * WORLD_W,
        y: Math.random() * WORLD_H,
        hp: (type === 'BOSS' ? 500 : 20) * scale,
        maxHp: (type === 'BOSS' ? 500 : 20) * scale,
        type: type,
        speed: type === 'BOSS' ? 2 : 4,
        size: type === 'BOSS' ? 60 : 20,
        color: type === 'BOSS' ? '#f00' : '#0f0'
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PLAZMERS Server running on port ${PORT}`));
