const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🎯 플레이어 기본 데이터 구조 (NFC UID 제거, 번호 기반 시스템)
let players = Array.from({ length: 12 }, (_, i) => ({
    index: i + 1,
    name: `대기자 ${i + 1}`,
    walletMoney: 100000, // 기본 지갑 금액 초기화
    currentMoney: 0,    
    betAmount: 0,       
    isCheckedIn: false, 
    status: "대기",     
    currentGame: "none",
    isAllIn: false 
}));

// 🎯 게임장별 구조체
let waitingQueues = { blackjack: [], holdem: [], indian: [] };
let gameRooms = {
    blackjack: { pot: 0, currentBet: 0, turnOrder: [], currentTurnIdx: 0 },
    holdem: { pot: 0, currentBet: 0, turnOrder: [], currentTurnIdx: 0, actionCount: 0 },
    indian: { pot: 0, currentBet: 0, turnOrder: [], currentTurnIdx: 0, actionCount: 0 }
};

// 📢 전체 클라이언트 상태 동기화 브로드캐스트
function broadcastState() {
    io.emit('game_update', { 
        players: players,
        queues: waitingQueues,
        rooms: gameRooms
    });
}

// 🌐 정적 HTML 라우팅
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/wallet/:pNum', (req, res) => res.sendFile(path.join(__dirname, 'public', 'wallet.html')));
app.get('/game/:pNum', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

// 🌟 판이 끝난 유저들을 대기열 목록으로 복귀시키는 함수
function returnToQueue(gameType, participantIds) {
    participantIds.forEach(pIndex => {
        const p = players.find(player => player.index === pIndex);
        if (p && p.isCheckedIn) {
            p.betAmount = 0;
            p.status = "대기열 진입";
            p.isAllIn = false; 
            
            if (!waitingQueues[gameType].includes(p.index)) {
                waitingQueues[gameType].push(p.index);
            }
        }
    });
}

// 🎯 [자동 정산 규칙 엔진] 기권승 발생 시 (포커/인디안 전용)
function checkAutoWin(gameType) {
    if (gameType === 'blackjack') return false; 
    
    const room = gameRooms[gameType];
    if (!room || room.turnOrder.length === 0) return false;
    
    const activeInRoom = players.filter(p => p.currentGame === gameType && p.isCheckedIn && room.turnOrder.includes(p.index));
    const survivors = activeInRoom.filter(p => p.status !== "다이");

    if (survivors.length === 1 && activeInRoom.length > 1) {
        const winner = survivors[0];
        io.emit('log', `👑 [🎉 자동 정산] 전원 다이! 승자 [${winner.name}]님에게 팟 머니 ${room.pot.toLocaleString()}칩이 지급됩니다.`);
        
        winner.currentMoney += room.pot;
        winner.status = "🏆 단독 승리!";
        
        const finishedPlayers = [...room.turnOrder];

        room.pot = 0;
        room.currentBet = 0;
        room.turnOrder = [];
        room.currentTurnIdx = 0;
        if (room.actionCount !== undefined) room.actionCount = 0;

        setTimeout(() => {
            returnToQueue(gameType, finishedPlayers);
            broadcastState();
        }, 4000);
        return true;
    }
    return false;
}

// 🎯 포커/인디안 범용 턴 체인저
function nextPokerTurn(gameType) {
    const room = gameRooms[gameType];
    if (!room || room.turnOrder.length === 0) return;
    
    let attempts = 0;
    while (attempts < room.turnOrder.length) {
        room.currentTurnIdx = (room.currentTurnIdx + 1) % room.turnOrder.length;
        const nextId = room.turnOrder[room.currentTurnIdx];
        const p = players.find(player => player.index === nextId);

        if (p && p.status !== "다이" && !p.isAllIn) {
            players.forEach(pl => {
                if (pl.currentGame === gameType && pl.status === "플레이 중") pl.status = "순서 대기";
            });
            p.status = "플레이 중";
            break;
        }
        attempts++;
    }
    broadcastState();
}

// 🛠️ 블랙잭 전용 순차 무한 로테이션 턴 엔진
function nextOfflineBlackjackTurn(room, gameType) {
    const hasUnbetted = room.turnOrder.some(id => {
        const p = players.find(player => player.index === id);
        return p && p.betAmount === 0;
    });

    if (hasUnbetted) {
        room.currentTurnIdx = (room.currentTurnIdx + 1) % room.turnOrder.length;
        let attempts = 0;
        while (attempts < room.turnOrder.length) {
            const nextId = room.turnOrder[room.currentTurnIdx];
            const p = players.find(player => player.index === nextId);
            
            if (p && p.betAmount === 0) {
                players.forEach(pl => { if(pl.currentGame === gameType && pl.status === "플레이 중") pl.status = "순서 대기"; });
                p.status = "플레이 중";
                io.emit('log', `🎲 [블랙잭] 다음 베팅 차례: ${p.name} (${nextId}번 시트)`);
                broadcastState();
                return;
            }
            room.currentTurnIdx = (room.currentTurnIdx + 1) % room.turnOrder.length;
            attempts++;
        }
    }

    const allBetted = room.turnOrder.every(id => {
        const p = players.find(player => player.index === id);
        return p && p.status === "베팅 완료";
    });

    if (allBetted) {
        io.emit('log', `🃏 [블랙잭] 전원 베팅 완료! 플레이를 시작합니다. 1번 플레이어부터 순서대로 액션을 진행합니다.`);
        room.currentTurnIdx = 0; 
        room.turnOrder.forEach((pId, idx) => {
            const p = players.find(player => player.index === pId);
            if (p) {
                p.status = (idx === 0) ? "플레이 중" : "순서 대기";
            }
        });
        broadcastState();
        return;
    }

    let searchAttempts = 0;
    while (searchAttempts < room.turnOrder.length) {
        room.currentTurnIdx = (room.currentTurnIdx + 1) % room.turnOrder.length;
        const nextActionId = room.turnOrder[room.currentTurnIdx];
        const p = players.find(player => player.index === nextActionId);

        if (p && p.status === "순서 대기") {
            players.forEach(pl => { if(pl.currentGame === gameType && pl.status === "플레이 중") pl.status = "순서 대기"; });
            p.status = "플레이 중";
            io.emit('log', `🎲 [블랙잭] 다음 턴 순환 차례: ${p.name} (${nextActionId}번 시트)`);
            broadcastState();
            return;
        }
        searchAttempts++;
    }

    io.emit('log', `🏁 [블랙잭] 모든 플레이어가 최종 스테이를 완료했습니다! 오프라인 정산을 진행해 주세요.`);
    broadcastState();
}

// 🎯 [순서 관리 엔진] 범용 턴 토서
function nextTurn(gameType) {
    if (gameType === 'blackjack') {
        const room = gameRooms[gameType];
        nextOfflineBlackjackTurn(room, gameType);
    } else {
        nextPokerTurn(gameType);
    }
}

// 👑 [관리자 API] 명단 교체
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
        player.isAllIn = false;
        broadcastState();
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false });
    }
});

// 👑 [관리자 API] 전원 테이블 칩 일괄 세팅
app.post('/api/admin/reset-all-money', (req, res) => {
    const { targetMoney } = req.body;
    const amount = parseInt(targetMoney);

    if (isNaN(amount) || amount < 0) {
        return res.status(400).json({ success: false, msg: "올바른 금액을 입력하세요." });
    }

    players.forEach(p => {
        if (p.isCheckedIn) {
            p.currentMoney = amount;
        }
    });

    io.emit('log', `📢 [하우스 관리] 딜러 권한으로 참여 중인 유저의 테이블 칩이 ${amount.toLocaleString()}칩으로 조정되었습니다.`);
    broadcastState();
    res.json({ success: true });
});

// 👑 [관리자 API] 전원 지갑 자산 일괄 세팅
app.post('/api/admin/reset-all-wallet', (req, res) => {
    const { targetWallet } = req.body;
    const amount = parseInt(targetWallet);

    if (isNaN(amount) || amount < 0) {
        return res.status(400).json({ success: false, msg: "올바른 금액을 입력하세요." });
    }

    players.forEach(p => {
        p.walletMoney = amount;
    });

    io.emit('log', `📢 [하우스 관리] 딜러 권한으로 전원의 지갑 원본 자산이 ${amount.toLocaleString()}원으로 조정되었습니다.`);
    broadcastState();
    res.json({ success: true });
});

// 📱 [지갑 충전 API]
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

// 🛒 [번호 기반 간편 결제 API] (NFC UID 리더기 대체)
app.get('/api/pay/:pNum/:amount', (req, res) => {
    const pNum = parseInt(req.params.pNum);
    const cost = parseInt(req.params.amount);

    if (isNaN(cost) || cost <= 0) {
        return res.send("INVALID_AMOUNT");
    }

    const player = players.find(p => p.index === pNum);
    if (!player) return res.send("NOT_FOUND");

    if (player.walletMoney >= cost) {
        player.walletMoney -= cost;
        io.emit('log', `🛒 [지불 완료] [${player.name}] 지갑에서 ${cost.toLocaleString()}원 차감`);
        broadcastState();
        res.send("SUCCESS");
    } else {
        res.send("NO_MONEY");
    }
});

// 🔌 소켓 서버 이벤트 리스너 루프
io.on('connection', (socket) => {
    
    // [공통] 플레이어가 페이지 로드 시 잔액을 요청할 때
    socket.on('request_balance', (data) => {
        const player = players.find(p => p.index === parseInt(data.pNum));
        if (player) {
            // 체크인 상태면 테이블 칩(currentMoney), 아니면 지갑(walletMoney) 전송
            const balance = player.isCheckedIn ? player.currentMoney : player.walletMoney;
            socket.emit('respond_balance', { balance: balance, isCheckedIn: player.isCheckedIn });
        }
    });

    // 🎲 [독립 다이스 게임 전용 연동]
    socket.on('dice_bet_result', (data) => {
        const player = players.find(p => p.index === parseInt(data.pNum));
        if (!player) return;

        const betAmount = parseInt(data.betAmount);
        const winAmount = parseInt(data.winAmount); // 얻은 총액 (배팅금 포함 반환금)
        const netProfit = winAmount - betAmount; // 순이익

        if (player.isCheckedIn) {
            player.currentMoney += netProfit;
            io.emit('log', `🎲 [다이스] [${player.name}]님이 ${betAmount.toLocaleString()}칩 배팅 -> 정산 결과: ${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString()}칩 (잔액: ${player.currentMoney.toLocaleString()}칩)`);
        } else {
            player.walletMoney += netProfit;
            io.emit('log', `🎲 [다이스] [${player.name}]님이 지갑 잔액으로 ${betAmount.toLocaleString()}원 배팅 -> 정산 결과: ${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString()}원 (잔액: ${player.walletMoney.toLocaleString()}원)`);
        }
        broadcastState();
    });

    // 🎰 [독립 슬롯머신 게임 전용 연동]
    socket.on('slot_spin_result', (data) => {
        const player = players.find(p => p.index === parseInt(data.pNum));
        if (!player) return;

        const betAmount = parseInt(data.betAmount);
        const winAmount = parseInt(data.winAmount);
        const netProfit = winAmount - betAmount;

        if (player.isCheckedIn) {
            player.currentMoney += netProfit;
            io.emit('log', `🎰 [슬롯] [${player.name}]님이 ${betAmount.toLocaleString()}칩 스핀 -> 정산 결과: ${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString()}칩 (잔액: ${player.currentMoney.toLocaleString()}칩)`);
        } else {
            player.walletMoney += netProfit;
            io.emit('log', `🎰 [슬롯] [${player.name}]님이 지갑 잔액으로 ${betAmount.toLocaleString()}원 스핀 -> 정산 결과: ${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString()}원 (잔액: ${player.walletMoney.toLocaleString()}원)`);
        }
        broadcastState();
    });

    // 📥 테이블 입장 (번호 기반 체크인)
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
            player.isAllIn = false;

            if (!waitingQueues[gameType].includes(player.index)) {
                waitingQueues[gameType].push(player.index);
            }
            io.emit('log', `⏳ [테이블 입장] ${player.name}님이 ${gameType} 대기열에 입장하였습니다.`);
            broadcastState();
        }
    });

    // 📤 테이블 퇴장 (번호 기반 정산/체크아웃)
    socket.on('nfc_table_checkout', (data) => {
        const player = players.find(p => p.index === parseInt(data.pNum));
        if (player && player.isCheckedIn) {
            const gameType = player.currentGame;
            const wasPlaying = (player.status === "플레이 중");
            
            player.isCheckedIn = false;
            player.status = "대기";
            player.walletMoney += (player.currentMoney + player.betAmount); // 테이블 칩 전액 복구
            player.currentMoney = 0;
            player.betAmount = 0;
            player.isAllIn = false;

            if (gameType !== "none") {
                waitingQueues[gameType] = waitingQueues[gameType].filter(id => id !== player.index);
                gameRooms[gameType].turnOrder = gameRooms[gameType].turnOrder.filter(id => id !== player.index);
            }
            player.currentGame = "none";

            if (wasPlaying && gameType !== "none") {
                nextTurn(gameType); 
            }
            
            checkAutoWin(gameType); 
            io.emit('log', `🚪 [퇴장 정산] ${player.name}님이 안전하게 정산을 마치고 퇴장하였습니다.`);
            broadcastState();
        }
    });

    // 📱 플레이어 조작 액션 수신 코어 엔진
    socket.on('player_action', (data) => {
        const player = players.find(p => p.index === parseInt(data.pNum));
        if (!player || player.status !== "플레이 중") return;

        const gameType = data.gameType || player.currentGame;
        const room = gameRooms[gameType];
        if (!room) return;

        // ──────────────────────────────────────────
        // 🃏 [분기 1] 오프라인 블랙잭 조작 엔진
        // ──────────────────────────────────────────
        if (gameType === 'blackjack') {
            if (data.actionType === 'bj_bet') {
                const betInput = parseInt(data.amount);
                if (isNaN(betInput) || betInput <= 0 || betInput > player.currentMoney) {
                    socket.emit('error_msg', { msg: "보유 칩 내에서 올바른 금액을 베팅하세요." });
                    return;
                }
                player.currentMoney -= betInput;
                player.betAmount = betInput; 
                room.pot += betInput;
                
                player.status = "베팅 완료";
                io.emit('log', `💰 [블랙잭] ${player.name}님이 ${betInput.toLocaleString()}칩 베팅 완료.`);
                
                nextOfflineBlackjackTurn(room, gameType);
                return;
            }

            if (data.actionType === 'hit') {
                player.status = "순서 대기"; 
                io.emit('log', `🎲 [블랙잭] ${player.name}님이 [히트]를 요청했습니다.`);
                
                nextOfflineBlackjackTurn(room, gameType);
                return;
            } 

            if (data.actionType === 'stay') {
                player.status = "스테이 완료"; 
                io.emit('log', `🔒 [블랙잭] ${player.name}님이 [스테이]를 선언했습니다.`);
                
                nextOfflineBlackjackTurn(room, gameType);
                return;
            }
            return;
        }

        // ──────────────────────────────────────────
        // 🎴 [분기 2] 포커 / 인디안 포커 베팅 엔진
        // ──────────────────────────────────────────
        if (room.actionCount === undefined) room.actionCount = 0;

        if (data.actionType === 'allin') {
            const allInAmount = player.currentMoney; 
            if (allInAmount <= 0) return;

            player.betAmount += allInAmount;
            room.pot += allInAmount;
            player.currentMoney = 0; 
            player.isAllIn = true;   

            if (player.betAmount > room.currentBet) {
                room.currentBet = player.betAmount;
            }

            player.status = "🔥 올인 완료";
            room.actionCount++;
            io.emit('log', `💥 [ALL-IN] ${player.name} 모든 칩 배팅!`);
        }
        else if (data.actionType === 'raise') {
            const RAISE_UNIT = 10000; 
            const callAmount = room.currentBet - player.betAmount;
            const totalRequired = callAmount + RAISE_UNIT;

            if (player.currentMoney >= totalRequired) {
                player.currentMoney -= totalRequired;
                player.betAmount += totalRequired;
                room.pot += totalRequired;
                room.currentBet = player.betAmount; 
                player.status = "레이즈 완료";
                room.actionCount++; 
                io.emit('log', `🔔 [배팅] ${player.name} -> 레이즈! 최고베팅: ${room.currentBet.toLocaleString()}칩`);
            } else {
                socket.emit('error_msg', { msg: "칩이 부족합니다! 올인을 이용하세요." });
                return;
            }
        } 
        else if (data.actionType === 'call') {
            if (room.actionCount === 0) {
                io.emit('log', `👑 [특수 룰] 첫 주자 [${player.name}]님이 콜(체크)을 선언했습니다! 판돈은 이월되고 판이 즉시 파괴됩니다.`);
                
                room.turnOrder.forEach(id => {
                    const p = players.find(player => player.index === id);
                    if (p) p.status = "첫 턴 패배 (몰수)";
                });

                const finished = [...room.turnOrder];
                room.currentBet = 0; 
                room.turnOrder = []; 
                room.actionCount = 0;

                setTimeout(() => {
                    returnToQueue(gameType, finished);
                    broadcastState();
                }, 5000); 
                return; 
            }

            const callAmount = room.currentBet - player.betAmount;
            if (callAmount > 0) { 
                if (player.currentMoney >= callAmount) {
                    player.currentMoney -= callAmount;
                    player.betAmount += callAmount;
                    room.pot += callAmount;
                    player.status = "콜 완료";
                    room.actionCount++;
                    io.emit('log', `✅ [배팅] ${player.name} -> 콜 매칭`);
                } else {
                    socket.emit('error_msg', { msg: "칩이 부족합니다!" });
                    return;
                }
            } else { 
                player.status = "체크 완료";
                room.actionCount++;
                io.emit('log', `✅ [배팅] ${player.name} -> 체크 Pass`);
            }
        } 
        else if (data.actionType === 'fold') {
            player.status = "다이";
            room.actionCount++;
            io.emit('log', `❌ [배팅] ${player.name} -> 기권(다이)`);
        }

        if (checkAutoWin(gameType)) return;

        const alivePlayers = players.filter(p => p.currentGame === gameType && p.isCheckedIn && room.turnOrder.includes(p.index) && p.status !== "다이");
        const betCheckPlayers = alivePlayers.filter(p => !p.isAllIn); 
        
        const isRoundOver = betCheckPlayers.length > 0 && betCheckPlayers.every(p => p.betAmount === room.currentBet);

        if (isRoundOver) {
            io.emit('log', `🎬 [베팅 종료] 전원 베팅 일치. 카드를 오픈하세요!`);
            alivePlayers.forEach(p => {
                if(!p.isAllIn) p.status = "쇼다운 (카드 오픈)";
            });
            room.actionCount = 0; 
            broadcastState();
        } else {
            nextPokerTurn(gameType);
        }
    });

    // 🎲 딜러 제어: 라운드 시작
    socket.on('admin_start_round', (data) => {
        const gameType = data.gameType;
        const room = gameRooms[gameType];

        if (waitingQueues[gameType] && waitingQueues[gameType].length > 0) {
            let participants = [...waitingQueues[gameType]];
            waitingQueues[gameType] = []; 

            for (let i = participants.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [participants[i], participants[j]] = [participants[j], participants[i]];
            }

            room.turnOrder = participants;
            room.currentTurnIdx = 0;
            if (room.actionCount !== undefined) room.actionCount = 0;
            room.pot = room.pot || 0; 

            room.turnOrder.forEach((pIndex, idx) => {
                const player = players.find(p => p.index === pIndex);
                if (player) {
                    player.isAllIn = false;
                    
                    if (gameType === 'blackjack') {
                        player.betAmount = 0; 
                        player.status = (idx === 0) ? "플레이 중" : "순서 대기";
                    } else {
                        player.betAmount = 5000; 
                        player.currentMoney -= 5000;
                        room.pot += 5000;
                        player.status = (idx === 0) ? "플레이 중" : "순서 대기";
                    }
                }
            });

            if (gameType !== 'blackjack') room.currentBet = 5000;
            else room.currentBet = 0;

            io.emit('log', `🎲 [게임 시작] ${gameType.toUpperCase()} 라운드가 가동되었습니다!`);
            broadcastState();
        }
    });

    // 🏆 포커/인디안 수동 승자 정산 API
    socket.on('admin_game_win', (data) => {
        const { gameType, winnerIndex } = data;
        const room = gameRooms[gameType];
        if (!room || gameType === 'blackjack') return;
        
        const targetIdx = parseInt(winnerIndex);
        const winner = players.find(p => p.index === targetIdx);
        
        if (!winner || winner.currentGame !== gameType || !room.turnOrder.includes(targetIdx)) {
            socket.emit('error_msg', { msg: `❌ 대상자가 참여 상태가 아닙니다.` });
            return;
        }

        const totalWinMoney = room.pot;
        winner.currentMoney += totalWinMoney;
        io.emit('log', `🎉 [수동 정산] 승자 [${winner.name}]님이 팟머니 ${totalWinMoney.toLocaleString()}칩을 획득했습니다!`);

        const finishedPlayers = [...room.turnOrder];
        room.pot = 0; 
        room.currentBet = 0; 
        room.turnOrder = []; 
        room.currentTurnIdx = -1;

        returnToQueue(gameType, finishedPlayers);
        broadcastState();
    });

    // 🃏 블랙잭 개별 플레이어 수동 결과 정산 핸들러
    socket.on('admin_blackjack_settle', (data) => {
        const { playerIndex, resultType } = data; 
        const room = gameRooms['blackjack'];
        
        const pIdx = parseInt(playerIndex);
        const p = players.find(player => player.index === pIdx);
        
        if (!p || p.currentGame !== 'blackjack' || !room.turnOrder.includes(pIdx)) return;
        if (p.betAmount <= 0) return; 

        let refund = 0;
        let logMsg = "";

        if (resultType === 'bj') {
            refund = Math.floor(p.betAmount * 2.0);
            p.status = "🃏 블랙잭 승리!";
            logMsg = `🃏 [블랙잭 정산] [${p.name}] 블랙잭! 2배 적용으로 ${refund.toLocaleString()}칩 획득!`;
        } else if (resultType === 'win') {
            refund = Math.floor(p.betAmount * 1.5);
            p.status = "🎉 일반 승리";
            logMsg = `🎉 [블랙잭 정산] [${p.name}] 승리! 1.5배 적용으로 ${refund.toLocaleString()}칩 획득!`;
        } else if (resultType === 'push') {
            refund = p.betAmount;
            p.status = "🤝 무승부 (Push)";
            logMsg = `🤝 [블랙잭 정산] [${p.name}] 무승부! 본인 베팅금 ${refund.toLocaleString()}칩 반환`;
        } else if (resultType === 'lose') {
            refund = 0;
            p.status = "❌ 패배/버스트";
            logMsg = `❌ [블랙잭 정산] [${p.name}] 패배 또는 버스트!`;
        }

        p.currentMoney += refund;
        p.betAmount = 0; 
        io.emit('log', logMsg);
        broadcastState();
    });

    // 🏁 블랙잭 테이블 라운드 종료 및 전체 복귀 트리거
    socket.on('admin_blackjack_clear', () => {
        const room = gameRooms['blackjack'];
        if (room.turnOrder.length === 0) return;

        io.emit('log', `🏁 [블랙잭] 정산 작업 완료. 테이블을 초기화하고 대기열로 복귀합니다.`);
        const finishedPlayers = [...room.turnOrder];

        room.pot = 0;
        room.currentBet = 0;
        room.turnOrder = [];
        room.currentTurnIdx = 0;

        returnToQueue('blackjack', finishedPlayers);
        broadcastState();
    });
});

// 🚀 포트 설정 및 서버 가동
const PORT = process.env.PORT || 8000;
http.listen(PORT, () => console.log(`🚀 번호 지정형 대기열 및 통합 게임 서버 가동 중 (Port: ${PORT})`));