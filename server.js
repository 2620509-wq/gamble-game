const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🎯 고정된 12인 카드 UID 세팅
const rfidCardUIDs = [
    "04:B9:C8:7A:D2:2A:81", "04:76:CB:7A:D2:2A:81", "04:75:CB:7A:D2:2A:81", 
    "04:74:CB:7A:D2:2A:81", "04:73:CB:7A:D2:2A:81", "04:99:C5:7A:D2:2A:81", 
    "04:98:C5:7A:D2:2A:81", "04:97:C5:7A:D2:2A:81", "04:A3:C5:7A:D2:2A:81", 
    "04:A2:C5:7A:D2:2A:81", "04:BF:C8:7A:D2:2A:81", "04:BE:C8:7A:D2:2A:81"
];

// 🎯 플레이어 기본 데이터 구조
let players = Array.from({ length: 12 }, (_, i) => ({
    index: i + 1,
    name: `대기자 ${i + 1}`,
    walletMoney: 0,
    currentMoney: 0,    
    betAmount: 0,       
    isCheckedIn: false, 
    status: "대기",     
    currentGame: "none",
    cardUid: rfidCardUIDs[i]
}));

// 🎯 게임장별 구조체
let waitingQueues = { blackjack: [], holdem: [], indian: [] };
let gameRooms = {
    blackjack: { pot: 0, currentBet: 0, turnOrder: [], currentTurnIdx: 0 },
    holdem: { pot: 0, currentBet: 0, turnOrder: [], currentTurnIdx: 0 },
    indian: { pot: 0, currentBet: 0, turnOrder: [], currentTurnIdx: 0 }
};

function broadcastState() {
    io.emit('game_update', { 
        players: players,
        queues: waitingQueues,
        rooms: gameRooms
    });
}

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/wallet/:pNum', (req, res) => res.sendFile(path.join(__dirname, 'public', 'wallet.html')));
app.get('/game/:pNum', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

// 🌟 [핵심 함수] 판이 끝난 유저들을 대기열 목록으로 복귀시키는 함수
function returnToQueue(gameType, participantIds) {
    participantIds.forEach(pIndex => {
        const p = players.find(player => player.index === pIndex);
        if (p && p.isCheckedIn) {
            p.betAmount = 0;
            p.status = "대기열 진입"; // 상태를 대기열 진입으로 원복
            
            // 대기열 큐 배열 맨 뒤에 순서대로 다시 집어넣음
            if (!waitingQueues[gameType].includes(p.index)) {
                waitingQueues[gameType].push(p.index);
            }
        }
    });
}

// 🎯 [자동 정산 규칙 엔진] 기권승 발생 시
function checkAutoWin(gameType) {
    const room = gameRooms[gameType];
    if (!room || room.turnOrder.length === 0) return false;
    
    const activeInRoom = players.filter(p => p.currentGame === gameType && p.isCheckedIn && room.turnOrder.includes(p.index));
    const survivors = activeInRoom.filter(p => p.status !== "다이");

    if (survivors.length === 1 && activeInRoom.length > 1) {
        const winner = survivors[0];
        io.emit('log', `👑 [🎉 자동 정산] 전원 다이! 승자 [${winner.name}]님에게 팟 머니 ${room.pot.toLocaleString()}칩이 지급됩니다.`);
        
        winner.currentMoney += room.pot;
        
        // 현재 판을 뛴 플레이어들의 명단을 임시 보관
        const finishedPlayers = [...room.turnOrder];

        // 테이블 리셋
        room.pot = 0;
        room.currentBet = 0;
        room.turnOrder = [];
        room.currentTurnIdx = 0;

        // 🌟 이번 판 끝난 유저 전원 대기열(Queue) 맨 뒤로 자동 재등록!
        returnToQueue(gameType, finishedPlayers);

        broadcastState();
        return true;
    }
    return false;
}

// 🎯 [순서 관리 엔진] 턴 넘기기
function nextTurn(gameType) {
    const room = gameRooms[gameType];
    if (!room || room.turnOrder.length === 0) return;

    if (checkAutoWin(gameType)) return;

    let attempts = 0;
    while (attempts < room.turnOrder.length) {
        room.currentTurnIdx = (room.currentTurnIdx + 1) % room.turnOrder.length;
        const nextPlayerIdx = room.turnOrder[room.currentTurnIdx];
        const nextPlayer = players.find(p => p.index === nextPlayerIdx);

        if (nextPlayer && nextPlayer.status !== "다이") {
            players.forEach(p => {
                if (p.currentGame === gameType && p.status === "플레이 중") p.status = "순서 대기";
            });
            nextPlayer.status = "플레이 중";
            break;
        }
        attempts++;
    }
    broadcastState();
}

// [관리자 API] 명단 교체
app.post('/api/admin/change-player', (req, res) => {
    const { pNum, newName, initMoney } = req.body;
    const player = players.find(p => p.index === parseInt(pNum));

    if (player) {
        if (player.currentGame !== "none") {
            waitingQueues[player.currentGame] = waitingQueues[player.currentGame].filter(id => id !== player.index);
        }
        player.name = newName || `플레이어 ${pNum}`;
        player.walletMoney = parseInt(initMoney) || 0;
        player.currentMoney = 0;
        player.betAmount = 0;
        player.isCheckedIn = false;
        player.status = "대기";
        player.currentGame = "none";
        broadcastState();
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false });
    }
});

// [지갑 충전 API]
app.post('/api/wallet/charge', (req, res) => {
    const { pNum, amount } = req.body;
    const player = players.find(p => p.index === parseInt(pNum));
    if (player) {
        player.walletMoney += parseInt(amount);
        broadcastState();
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false });
    }
});

// [아두이노 결제 API]
app.get('/api/arduino/pay/:uid', (req, res) => {
    const uid = req.params.uid.trim().toLowerCase();
    const player = players.find(p => p.cardUid === uid);
    if (!player) return res.send("NOT_FOUND");

    const COST = 10000;
    if (player.walletMoney >= COST) {
        player.walletMoney -= COST;
        io.emit('log', `🛒 [RFID 결제] [${player.name}] 지갑에서 ${COST.toLocaleString()}원 차감`);
        broadcastState();
        res.send("SUCCESS");
    } else {
        res.send("NO_MONEY");
    }
});

// 🔌 소켓 서버 이벤트 리스너 루프
io.on('connection', (socket) => {
    broadcastState();

    // 지갑에서 [매트 입장] 터치 시 대기열 최초 등록
    socket.on('nfc_table_checkin', (data) => {
        const player = players.find(p => p.index === parseInt(data.pNum));
        const gameType = data.gameType;

        if (player && !player.isCheckedIn) {
            player.isCheckedIn = true;
            player.currentGame = gameType;
            player.status = "대기열 진입"; 
            player.currentMoney = player.walletMoney;
            player.walletMoney = 0;
            player.betAmount = 0;

            if (!waitingQueues[gameType].includes(player.index)) {
                waitingQueues[gameType].push(player.index);
            }
            io.emit('log', `⏳ [대기 등록] ${player.name}님이 ${gameType} 대기열에 진입했습니다.`);
            broadcastState();
        }
    });

    // 테이블 퇴장 (유저가 판을 아예 이탈할 때)
    // server.js 내의 nfc_table_checkout 이벤트 내부 끝부분 확인용
socket.on('nfc_table_checkout', (data) => {
    const player = players.find(p => p.index === parseInt(data.pNum));
    if (player && player.isCheckedIn) {
        const gameType = player.currentGame;
        
        player.isCheckedIn = false;
        player.status = "대기";
        player.walletMoney += (player.currentMoney + player.betAmount); // 자산 안전 복구
        player.currentMoney = 0;
        player.betAmount = 0;

        if (gameType !== "none") {
            waitingQueues[gameType] = waitingQueues[gameType].filter(id => id !== player.index);
            gameRooms[gameType].turnOrder = gameRooms[gameType].turnOrder.filter(id => id !== player.index);
        }
        player.currentGame = "none";

        // 🌟 [추가/보완] 만약 이 사람이 턴을 가지고 있는 상태에서 나갔다면 다음 사람에게 턴 토스!
        nextTurn(gameType); 
        
        checkAutoWin(gameType); // 남은 사람이 1명이면 자동 정산
        broadcastState();
    }
});

    // 배팅 액션 엔진
    socket.on('player_action', (data) => {
        const player = players.find(p => p.index === parseInt(data.pNum));
        if (!player) return;

        if (data.actionType === 'refresh') {
            broadcastState();
            return;
        }

        const room = gameRooms[player.currentGame];
        if (!room) return;

        if (player.status === "플레이 중") {
            if (data.actionType === 'raise') {
                const RAISE_UNIT = 10000; 
                const callAmount = room.currentBet - player.betAmount;
                const totalRequired = callAmount + RAISE_UNIT;

                if (player.currentMoney >= totalRequired) {
                    player.currentMoney -= totalRequired;
                    player.betAmount += totalRequired;
                    room.pot += totalRequired;
                    room.currentBet = player.betAmount; 
                    
                    player.status = "레이즈 완료";
                    io.emit('log', `🔔 [배팅] ${player.name} -> 판돈 인상! 최고베팅: ${room.currentBet.toLocaleString()}칩`);
                } else {
                    socket.emit('error_msg', { msg: "레이즈 자금이 부족합니다!" });
                    return;
                }
            } 
            else if (data.actionType === 'call') {
                const callAmount = room.currentBet - player.betAmount;
                
                if (callAmount > 0) { 
                    if (player.currentMoney >= callAmount) {
                        player.currentMoney -= callAmount;
                        player.betAmount += callAmount;
                        room.pot += callAmount;
                        player.status = "콜 완료";
                        io.emit('log', `✅ [배팅] ${player.name} -> 콜 매칭 (+${callAmount.toLocaleString()}칩)`);
                    } else {
                        socket.emit('error_msg', { msg: "칩이 부족합니다! 다이(Fold)하세요." });
                        return;
                    }
                } else { 
                    player.status = "체크 완료";
                    io.emit('log', `✅ [배팅] ${player.name} -> 체크 패스`);
                }
            } 
            else if (data.actionType === 'fold') {
                player.status = "다이";
                io.emit('log', `❌ [배팅] ${player.name} -> 기권(다이)`);
            }

            if (checkAutoWin(player.currentGame)) return;

            const activePlayers = players.filter(p => p.currentGame === player.currentGame && p.isCheckedIn && room.turnOrder.includes(p.index) && p.status !== "다이");
            const isRoundOver = activePlayers.every(p => p.betAmount === room.currentBet);

            if (isRoundOver) {
                io.emit('log', `🎬 [라운드 종료] 전원 금액 일치. 쇼다운(카드 오픈) 돌입!`);
                activePlayers.forEach(p => p.status = "쇼다운 (카드 오픈)");
                broadcastState();
            } else {
                nextTurn(player.currentGame);
            }
        }
    });

    // 🎲 딜러 제어: 라운드 시작 (대기열 목록에서 유저들을 데려와 셔플 진행)
    socket.on('admin_start_round', (data) => {
        const gameType = data.gameType;
        const room = gameRooms[gameType];

        if (waitingQueues[gameType].length > 0) {
            let participants = [...waitingQueues[gameType]];
            waitingQueues[gameType] = []; // 판이 열렸으므로 대기열 리스트 초기화

            for (let i = participants.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [participants[i], participants[j]] = [participants[j], participants[i]];
            }

            room.turnOrder = participants;
            room.currentTurnIdx = 0;

            room.turnOrder.forEach((pIndex, idx) => {
                const player = players.find(p => p.index === pIndex);
                if (player) {
                    player.betAmount = 5000; 
                    player.currentMoney -= 5000;
                    room.pot += 5000;
                    player.status = (idx === 0) ? "플레이 중" : "순서 대기";
                }
            });

            room.currentBet = 5000;
            io.emit('log', `🎲 [게임 시작] ${gameType} 테이블 뉴 라운드가 시작되었습니다!`);
            broadcastState();
        }
    });

    // 🏆 딜러 제어: 수동 승자 정산 (종료 시 대기열 자동 복귀 로직 추가)
    socket.on('admin_game_win', (data) => {
        const { gameType, winnerIndex } = data;
        const room = gameRooms[gameType];
        
        if (!room) return;
        
        const targetIdx = parseInt(winnerIndex);
        const winner = players.find(p => p.index === targetIdx);
        
        if (!winner) {
            socket.emit('error_msg', { msg: `❌ ${winnerIndex}번 자리에 유저가 없습니다.` });
            return;
        }
        if (winner.currentGame !== gameType) {
            socket.emit('error_msg', { msg: `❌ ${winner.name}님은 현재 이 방에 참가하지 않았습니다.` });
            return;
        }
        const isRealPlayer = room.turnOrder.includes(targetIdx);
        if (!isRealPlayer || winner.status === "대기열 진입") {
            socket.emit('error_msg', { msg: `❌ ${winner.name}님은 게임 참여자 명단에 없습니다.` });
            return;
        }
        if (room.pot <= 0) {
            socket.emit('error_msg', { msg: `❌ 정산할 판돈이 없습니다.` });
            return;
        }

        // 칩 지급
        const totalWinMoney = room.pot;
        winner.currentMoney += totalWinMoney;

        io.emit('log', `🎉 [수동 정산] 딜러 판정 결과, 실제 참가자 [${winner.name}]님이 ${totalWinMoney.toLocaleString()}칩을 획득했습니다!`);

        // 이번 판 진행한 플레이어들 복사 명단 확보
        const finishedPlayers = [...room.turnOrder];

        // 게임룸 상태 포맷 리셋
        room.pot = 0;
        room.currentBet = 0;
        room.turnOrder = [];
        room.currentTurnIdx = -1;

        // 🌟 [최종 변경] 수동 정산 후에도 참여한 유저 전원 대기열(Queue)에 자동으로 다시 줄 서게 만듦!
        returnToQueue(gameType, finishedPlayers);

        broadcastState();
    });
});

http.listen(8000, () => console.log('🚀 무한 순환형 대기열 시스템 가동 중 (Port: 8000)'));