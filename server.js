const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🎯 고정된 12인 카드 UID 세팅
const rfidCardUIDs = [
    "88:04:b9:c8", "88:04:76:cb", "88:04:75:cb", 
    "88:04:74:cb", "88:04:73:cb", "88:04:99:c5", 
    "88:04:98:c5", "88:04:97:c5", "88:04:a3:c5", 
    "88:04:a2:c5", "88:04:bf:c8", "88:04:be:c8"
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

// [관리자 API] 1~12번 전원 '지갑 잔고(walletMoney)' 일괄 설정
app.post('/api/admin/reset-all-wallet', (req, res) => {
    const { targetWallet } = req.body;
    const amount = parseInt(targetWallet);

    if (isNaN(amount) || amount < 0) {
        return res.status(400).json({ success: false, msg: "올바른 금액을 입력하세요." });
    }

    // 🌟 테이블 참여 여부와 상관없이 1번부터 12번까지 전체 유저의 지갑 잔고 일괄 변경
    players.forEach(p => {
        p.walletMoney = amount;
    });

    io.emit('log', `📢 [하우스 관리] 딜러 권한으로 1~12번 전원의 지갑 원본 자산이 ${amount.toLocaleString()}원으로 일괄 조정되었습니다.`);
    
    broadcastState();
    res.json({ success: true });
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

    const COST = 1000;
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

    let blackjackDealerScore = 0; // 딜러 점수 전역 기록용

// 🔌 소켓 내부의 player_action 리스너 루프 교체
socket.on('player_action', (data) => {
    const player = players.find(p => p.index === parseInt(data.pNum));
    if (!player || player.status !== "플레이 중") return;

    const gameType = player.currentGame;
    const room = gameRooms[gameType];
    if (!room) return;

    // ==========================================
    // 🃏 [오프라인 하이브리드] 블랙잭 룰 엔진
    // ==========================================
    if (gameType === 'blackjack') {
        if (data.actionType === 'hit') {
            // 점수 계산 안 함! 오직 딜러에게 "히트했다"고 상태만 보여줌
            player.status = "히트 선택! (카드 대기)";
            io.emit('log', `🎲 [오프라인 블랙잭] ${player.name} 플레이어가 [히트]를 요청했습니다. 딜러님 카드를 한 장 더 주세요!`);
            broadcastState(); 
        } 
        else if (data.actionType === 'stay') {
            // 스테이를 누르면 이 플레이어는 완료 상태로 두고 다음 사람으로 차례를 넘김
            player.status = "스테이 완료";
            io.emit('log', `🔒 [오프라인 블랙잭] ${player.name} 플레이어가 [스테이]를 선언했습니다.`);
            nextOfflineBlackjackTurn(room, gameType);
        }
        return;
    }

    // ==========================================
    // 🎴 [분기 2] 기존 텍사스 홀덤 & 인디안 포커 베팅 엔진
    // ==========================================
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
                socket.emit('error_msg', { msg: "칩이 부족합니다! 다이하세요." });
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

    // 포커 판돈 매칭 및 자동 턴 체인지 검사
    if (checkAutoWin(gameType)) return;

    const activePlayers = players.filter(p => p.currentGame === gameType && p.isCheckedIn && room.turnOrder.includes(p.index) && p.status !== "다이");
    const isRoundOver = activePlayers.every(p => p.betAmount === room.currentBet);

    if (isRoundOver) {
        io.emit('log', `🎬 [라운드 종료] 전원 금액 일치. 쇼다운 돌입! 관리자가 정산해 주세요.`);
        activePlayers.forEach(p => p.status = "쇼다운 (카드 오픈)");
        broadcastState();
    } else {
        nextTurn(gameType);
    }
});

// 🛠️ 블랙잭 전용 다음 턴 제어 알고리즘     
function nextOfflineBlackjackTurn(room, gameType) {
    // 아직 차례를 마치지 않은("순서 대기" 상태인) 다음 사람 찾기
    const nextPlayerId = room.turnOrder.find(id => {
        const p = players.find(player => player.index === id);
        return p && p.status === "순서 대기";
    });

    if (nextPlayerId) {
        const nextPlayer = players.find(p => p.index === nextPlayerId);
        nextPlayer.status = "플레이 중";
        io.emit('log', `🎲 [블랙잭] 다음 차례: ${nextPlayer.name} (${nextPlayerId}번 시트)`);
        broadcastState();
    } else {
        // 모든 플레이어가 스테이를 선언해서 차례가 끝난 경우
        io.emit('log', `🏁 [블랙잭] 모든 플레이어의 선택이 끝났습니다! 딜러님 오프라인에서 딜러 카드를 오픈하고 최종 정산해 주세요.`);
        
        // 딜러가 오프라인에서 게임을 완전히 끝내고 다음 판을 준비할 수 있도록 상태 유지
        // 정산은 관리자가 admin.html에서 [승자 정산] 버튼을 누르면 초기화되도록 넘김
        broadcastState();
    }
}

// 🏆 블랙잭 결과 전원 자동 정산 및 무한 대기열 재순환 통합
function settleBlackjackRound(room, gameType) {
    io.emit('log', `🏁 [블랙잭] 최종 결과 정산 (딜러: ${blackjackDealerScore}점)`);
    const BASE_BET = 10000; // 블랙잭 판당 기본 배팅금 정의

    room.turnOrder.forEach(id => {
        const p = players.find(player => player.index === id);
        if(!p) return;

        if (p.betAmount > 21) {
            p.currentMoney -= BASE_BET;
            room.pot += BASE_BET;
            p.status = "패배 (버스트)";
        } else if (blackjackDealerScore > 21 || p.betAmount > blackjackDealerScore) {
            p.currentMoney += BASE_BET;
            p.status = "🎉 승리!";
        } else if (p.betAmount < blackjackDealerScore) {
            p.currentMoney -= BASE_BET;
            room.pot += BASE_BET;
            p.status = "패배 (점수 미달)";
        } else {
            p.status = "무승부 (Push)";
        }
    });

    const finishedPlayers = [...room.turnOrder];
    
    // 테이블 상태 포맷 리셋
    room.pot = 0;
    room.currentBet = 0;
    room.turnOrder = [];
    room.currentTurnIdx = 0;

    // 판이 완벽하게 끝났으니 유저들 대기열(Queue) 맨 뒤로 차례대로 자동 복귀시키기!
    setTimeout(() => {
        returnToQueue(gameType, finishedPlayers);
        broadcastState();
    }, 4000); // 승패 결과 배지를 눈으로 4초간 확인할 수 있게 딜레이 후 복귀
}

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