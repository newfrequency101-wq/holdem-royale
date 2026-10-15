'use strict';
// Hold-em Royale multiplayer server: runs shared cash tables. Real players take over bot seats when
// they sit down, and bots take the seats back when they leave. The server shuffles and deals, so
// players never receive anyone else's hole cards until a showdown.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TURN_TIME = 10000;          // ms a player has to act before auto check/fold
const AWAY_AFTER = 3;             // timeouts in a row before a player sits out
const HAND_GAP = 3200;            // ms between hands
const MAX_MESSAGE = 512;          // bytes

// ---------------------------------------------------------------- config (matches the game page)
const CASH = [
  { sb: 10, bb: 20, buy: 2000 }, { sb: 50, bb: 100, buy: 10000 }, { sb: 250, bb: 500, buy: 50000 },
  { sb: 1000, bb: 2000, buy: 200000 }, { sb: 5000, bb: 10000, buy: 1000000 },
];
const SNG_BUYS = [1000, 5000, 25000, 100000, 500000];
const SNG_STACK = 1500, SNG_HANDS_PER_LEVEL = 5, SNG_PLAYERS = 5;
const SNG_BLINDS = [[10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400],
  [300, 600], [500, 1000], [750, 1500], [1000, 2000]];
const BOTS = [['Rosie', '👩‍🦰'], ['Duke', '🤠'], ['Kitty', '🐱'], ['Viper', '🐍'], ['Big Al', '🧔'], ['Lucky', '🍀'],
  ['Foxy', '🦊'], ['Bruno', '🐻'], ['Mia', '👩'], ['Tex', '🎩'], ['Pumpkin', '🎃'], ['Doc', '🧐'], ['Nana', '👵'],
  ['Robo', '🤖'], ['Shark', '🦈'], ['Rocky', '🦍'], ['Queenie', '👸'], ['Pixel', '👾']];
const AVATARS = ['😎', '🙂', '🤠', '🧐', '😈', '🤖', '👽', '🐯', '🐼', '🦁', '🐸', '👑'];
const CHAT = ['Nice hand', 'Good game', 'Wow!', 'No way!', 'Good luck', '😂'];
const REPLIES = { 'Nice hand': ['Thanks!', 'Lucky river 😅'], 'Good game': ['GG!', 'Good game!'], 'Wow!': ['Wow!', '😮'],
  'No way!': ['Way! 😎', 'Believe it!'], 'Good luck': ['You too!', 'Good luck!'], '😂': ['😂', '😆'] };

// ---------------------------------------------------------------- hand evaluation
const rankOf = c => c % 13 + 2, suitOf = c => (c / 13) | 0;
function eval5(cs) {
  const r = cs.map(rankOf).sort((a, b) => b - a);
  const s0 = suitOf(cs[0]);
  const flush = suitOf(cs[1]) === s0 && suitOf(cs[2]) === s0 && suitOf(cs[3]) === s0 && suitOf(cs[4]) === s0;
  const cnt = {};
  for (const x of r) cnt[x] = (cnt[x] || 0) + 1;
  const g = Object.keys(cnt).map(k => [cnt[k], +k]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let sh = 0;
  if (g.length === 5) {
    if (r[0] - r[4] === 4) sh = r[0];
    else if (r[0] === 14 && r[1] === 5) sh = 5;
  }
  let cat, k;
  if (sh && flush) { cat = 8; k = [sh]; }
  else if (g[0][0] === 4) { cat = 7; k = [g[0][1], g[1][1]]; }
  else if (g[0][0] === 3 && g[1][0] === 2) { cat = 6; k = [g[0][1], g[1][1]]; }
  else if (flush) { cat = 5; k = r; }
  else if (sh) { cat = 4; k = [sh]; }
  else if (g[0][0] === 3) { cat = 3; k = g.map(x => x[1]); }
  else if (g[0][0] === 2 && g[1][0] === 2) { cat = 2; k = g.map(x => x[1]); }
  else if (g[0][0] === 2) { cat = 1; k = g.map(x => x[1]); }
  else { cat = 0; k = r; }
  let sc = cat;
  for (let i = 0; i < 5; i++) sc = sc * 15 + (k[i] || 0);
  return sc;
}
const COMBOS = {};
for (const n of [5, 6, 7]) {
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === 5) { out.push(cur.slice()); return; }
    for (let i = start; i < n; i++) { cur.push(i); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []); COMBOS[n] = out;
}
function bestScore(cards) {
  let best = -1;
  for (const cb of COMBOS[cards.length]) {
    const s = eval5([cards[cb[0]], cards[cb[1]], cards[cb[2]], cards[cb[3]], cards[cb[4]]]);
    if (s > best) best = s;
  }
  return best;
}
function bestHand(cards) {
  let best = -1, five = null;
  for (const cb of COMBOS[cards.length]) {
    const f = cb.map(i => cards[i]), s = eval5(f);
    if (s > best) { best = s; five = f; }
  }
  return { score: best, cards: five, name: handName(best) };
}
const NAME = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const nm = r => NAME[r] || String(r);
const pl = r => r === 6 ? 'Sixes' : nm(r) + 's';
function handName(sc) {
  const k = []; let s = sc;
  for (let i = 4; i >= 0; i--) { k[i] = s % 15; s = Math.floor(s / 15); }
  switch (s) {
    case 0: return nm(k[0]) + ' High';
    case 1: return 'Pair of ' + pl(k[0]);
    case 2: return 'Two Pair, ' + pl(k[0]) + ' & ' + pl(k[1]);
    case 3: return 'Three ' + pl(k[0]);
    case 4: return 'Straight, ' + nm(k[0]) + ' High';
    case 5: return 'Flush, ' + nm(k[0]) + ' High';
    case 6: return 'Full House, ' + pl(k[0]) + ' over ' + pl(k[1]);
    case 7: return 'Four ' + pl(k[0]);
    default: return k[0] === 14 ? 'Royal Flush' : 'Straight Flush, ' + nm(k[0]) + ' High';
  }
}
function equity(hole, board, nOpp, iters) {
  if (nOpp <= 0) return 1;
  const used = new Set(hole.concat(board)), rest = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  const need = nOpp * 2 + 5 - board.length;
  let won = 0;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(Math.random() * (rest.length - i));
      const t = rest[i]; rest[i] = rest[j]; rest[j] = t;
    }
    const b = board.concat(rest.slice(nOpp * 2, need));
    const mine = bestScore(hole.concat(b));
    let lost = false, ties = 0;
    for (let o = 0; o < nOpp; o++) {
      const s = bestScore([rest[o * 2], rest[o * 2 + 1]].concat(b));
      if (s > mine) { lost = true; break; }
      if (s === mine) ties++;
    }
    if (!lost) won += 1 / (ties + 1);
  }
  return won / iters;
}

// ---------------------------------------------------------------- helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = n => '$' + Math.round(n).toLocaleString('en-US');
function short(n) {
  if (n >= 1e6) return '$' + +(n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M';
  if (n >= 1e4) return '$' + +(n / 1e3).toFixed(n % 1e3 ? 1 : 0) + 'K';
  return fmt(n);
}
const nextIdx = (from, pred) => { for (let k = 1; k <= 5; k++) { const j = (from + k) % 5; if (pred(j)) return j; } return -1; };
const pick = a => a[Math.floor(Math.random() * a.length)];
const ord = n => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
const human = (c, chips) => ({ name: c.name, avatar: c.avatar, chips, isBot: false, client: c, cards: [], bet: 0, total: 0 });
function send(c, msg) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); }

// ---------------------------------------------------------------- tables
const tables = new Map();
let tableSeq = 0;

// A cash table (bots fill the seats real players don't take) or a Sit-N-Go tournament (five real players).
class Table {
  constructor(stage, mode = 'cash', players = []) {
    this.id = ++tableSeq; this.stage = stage; this.mode = mode; this.handNo = 0;
    this.board = []; this.turn = -1; this.turnId = 0; this.deadline = 0; this.msg = ''; this.winCards = null;
    this.watchers = new Set(); this.running = false; this.inHand = false; this.actionResolve = null;
    if (mode === 'sng') {
      Object.assign(this, { sb: SNG_BLINDS[0][0], bb: SNG_BLINDS[0][1], buy: SNG_BUYS[stage] });
      this.seats = players.map(c => human(c, SNG_STACK)).sort(() => Math.random() - .5);
      players.forEach(c => { this.watchers.add(c); c.table = this; });
    } else {
      Object.assign(this, { sb: CASH[stage].sb, bb: CASH[stage].bb, buy: CASH[stage].buy });
      this.seats = [];
      for (let i = 0; i < 5; i++) this.seats.push(this.newBot());
    }
    this.dealer = Math.floor(Math.random() * 5);
    tables.set(this.id, this);
  }
  newBot() {
    const used = (this.seats || []).map(p => p.name);
    const [name, avatar] = pick(BOTS.filter(b => !used.includes(b[0])));
    const chips = Math.round(this.buy * (.5 + Math.random() * 1.1) / this.bb) * this.bb;
    return { name, avatar, chips, isBot: true, aggr: .6 + Math.random() * .9, loose: .7 + Math.random() * .6, cards: [], bet: 0, total: 0 };
  }
  freeSeat() { return this.seats.findIndex(p => p.isBot && !p.reservedBy); }
  humanCount() { return this.seats.filter(p => (!p.isBot && p.client) || p.reservedBy).length; }

  snapshot(c) {
    const you = this.seats.findIndex(p => !p.isBot && p.client === c);
    const reserved = this.seats.findIndex(p => p.reservedBy === c);
    const s = {
      you, reserved, mode: this.mode, stage: this.stage, handNo: this.handNo, sb: this.sb, bb: this.bb, buy: this.buy,
      dealer: this.dealer, board: this.board,
      turn: this.turn, turnId: this.turnId, turnLeft: this.actionResolve ? Math.max(0, this.deadline - Date.now()) : 0,
      msg: this.msg, winCards: this.winCards,
      seats: this.seats.map((p, i) => ({
        name: p.name, avatar: p.avatar, chips: p.chips, bet: p.bet || 0, total: p.total || 0, folded: !!p.folded,
        allIn: !!p.allIn, sitOut: !!p.sitOut, isBot: !!p.isBot, away: !!p.away, tag: p.tag || null,
        out: !!p.out, rank: p.rank || 0,
        cards: (p.cards || []).map(cd => (i === you || p.showCards) ? cd : null),
      })),
    };
    if (you >= 0 && this.turn === you && this.actionResolve) {
      const p = this.seats[you], others = this.seats.some(q => q !== p && !q.folded && !q.allIn);
      const toCall = this.currentBet - p.bet, maxTo = p.chips + p.bet;
      s.options = { toCall, callAmt: Math.min(toCall, p.chips), chips: p.chips, bet: p.bet, currentBet: this.currentBet,
        maxTo, minTo: Math.min(this.currentBet + this.minRaise, maxTo), canRaise: p.chips > toCall && others,
        potAll: this.seats.reduce((a, q) => a + q.total, 0), sb: this.sb, timeLeft: Math.max(0, this.deadline - Date.now()) };
    }
    return s;
  }
  emit(ev) { for (const c of this.watchers) send(c, { t: 'ev', ev, s: this.snapshot(c) }); }

  addClient(c) {
    const i = this.freeSeat();
    this.watchers.add(c); c.table = this;
    this.seats[i].reservedBy = c;
    send(c, { t: 'joined', stage: this.stage, buy: this.buy });
    if (!this.inHand) this.swapIn(i, true);
    else this.emit({ kind: 'notice', notice: `${c.name} joined · waiting for next hand` });
    if (!this.running) this.run();
  }
  swapIn(i, justJoined) {
    const c = this.seats[i].reservedBy;
    this.seats[i] = { name: c.name, avatar: c.avatar, chips: this.buy, isBot: false, client: c, cards: [], bet: 0, total: 0 };
    this.emit({ kind: 'seat', seat: i, text: '👋', notice: `${c.name} ${justJoined ? 'joined the table' : 'sat down'}` });
  }
  // Puts a new bot in seat i; notice(botName) is the message shown to the table.
  replaceWithBot(i, notice) {
    const res = this.seats[i].reservedBy;
    this.seats[i] = this.newBot(); this.seats[i].reservedBy = res;
    if (!res) this.emit({ kind: 'seat', seat: i, text: 'Hi all! 👋', notice: notice(this.seats[i].name) });
  }
  removeClient(c) {
    this.watchers.delete(c); c.table = null;
    const r = this.seats.findIndex(p => p.reservedBy === c);
    if (r >= 0) delete this.seats[r].reservedBy;
    const i = this.seats.findIndex(p => !p.isBot && p.client === c);
    if (i < 0) return;
    const p = this.seats[i];
    p.client = null;
    if (this.mode === 'sng') {
      // Tournament seats stay put: a player who leaves keeps checking or folding until their chips run out.
      if (!p.out) this.emit({ kind: 'notice', notice: `${p.name} left the tournament` });
      if (this.turn === i && this.actionResolve) this.actionResolve({ type: this.currentBet - p.bet === 0 ? 'check' : 'fold' });
      return;
    }
    if (!this.inHand) { this.replaceWithBot(i, bot => `${p.name} left the table · ${bot} took the seat`); return; }
    this.emit({ kind: 'notice', notice: `${p.name} left the table` });
    if (this.turn === i && this.actionResolve) this.actionResolve({ type: 'fold' });
    else if (!p.folded && !p.sitOut) { p.folded = true; p.tag = { text: 'LEFT', cls: 't-fold' }; this.emit({ kind: 'state' }); }
  }

  async run() {
    if (this.mode === 'sng') return this.runSng();
    this.running = true;
    await sleep(600);
    for (;;) {
      this.seats.forEach((p, i) => {
        if (!p.isBot && !p.client) this.replaceWithBot(i, bot => `${bot} took ${p.name}'s seat`);
        else if (p.isBot && p.chips <= 0) this.replaceWithBot(i, bot => `${p.name} busted · ${bot} took the seat`);
      });
      this.seats.forEach((p, i) => { if (p.reservedBy) this.swapIn(i, false); });
      if (!this.humanCount()) { this.running = false; tables.delete(this.id); return; }
      if (this.seats.filter(p => p.chips > 0).length < 2) { await sleep(1000); continue; }
      try { await this.playHand(); }
      catch (e) { console.error('hand error', e); }
      this.inHand = false; this.turn = -1;
      this.emit({ kind: 'handEnd' });
      await sleep(HAND_GAP);
    }
  }

  async runSng() {
    this.running = true;
    await sleep(1500);
    for (;;) {
      const left = this.seats.filter(p => !p.out);
      if (left.length <= 1) {
        const w = left[0];
        if (w) { w.rank = 1; this.emit({ kind: 'sngEnd', ranks: [{ seat: this.seats.indexOf(w), rank: 1 }], notice: `${w.name} wins the tournament! 🏆` }); }
        break;
      }
      if (!this.seats.some(p => p.client)) break;
      this.handNo++;
      const lv = Math.min(Math.floor((this.handNo - 1) / SNG_HANDS_PER_LEVEL), SNG_BLINDS.length - 1);
      const up = SNG_BLINDS[lv][1] !== this.bb;
      [this.sb, this.bb] = SNG_BLINDS[lv];
      if (up) this.emit({ kind: 'notice', notice: `Blinds up: ${short(this.sb)}/${short(this.bb)}` });
      try { await this.playHand(); }
      catch (e) { console.error('hand error', e); }
      this.inHand = false; this.turn = -1;
      const busted = this.seats.filter(p => !p.out && p.chips <= 0);
      if (busted.length) {
        const remaining = this.seats.filter(p => !p.out && p.chips > 0).length;
        busted.sort((a, b) => b.startChips - a.startChips).forEach((p, k) => { p.out = true; p.rank = remaining + 1 + k; });
        this.emit({ kind: 'sngEnd', ranks: busted.map(p => ({ seat: this.seats.indexOf(p), rank: p.rank })),
          notice: busted.map(p => `${p.name} finished ${ord(p.rank)}`).join(' · ') });
      }
      this.emit({ kind: 'handEnd' });
      await sleep(HAND_GAP);
    }
    this.running = false; tables.delete(this.id);
  }

  async playHand() {
    const P = this.seats;
    this.inHand = true;
    P.forEach(p => {
      p.sitOut = p.chips <= 0;
      Object.assign(p, { cards: [], folded: p.sitOut, allIn: false, bet: 0, total: 0, acted: false, showCards: false, tag: null, startChips: p.chips });
    });
    this.board = []; this.turn = -1; this.msg = ''; this.winCards = null;
    const live = i => !P[i].sitOut;
    this.dealer = nextIdx(this.dealer, live);
    const n = P.filter(p => !p.sitOut).length;
    const sbI = n === 2 ? this.dealer : nextIdx(this.dealer, live), bbI = nextIdx(sbI, live);
    const blind = (i, amt) => { const p = P[i], a = Math.min(amt, p.chips); p.chips -= a; p.bet = a; p.total = a; if (!p.chips) p.allIn = true; };
    blind(sbI, this.sb); blind(bbI, this.bb);
    this.currentBet = this.bb; this.minRaise = this.bb;
    this.emit({ kind: 'hand' });
    await sleep(400);

    const deck = []; for (let c = 0; c < 52; c++) deck.push(c);
    for (let i = 51; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    for (let r = 0; r < 2; r++) {
      for (let k = 0, i = sbI; k < n; k++, i = nextIdx(i, live)) {
        P[i].cards.push(deck.pop()); this.emit({ kind: 'deal', seat: i }); await sleep(130);
      }
    }

    await this.bettingRound(nextIdx(bbI, live));
    let revealed = false;
    for (const count of [3, 1, 1]) {
      if (P.filter(p => !p.folded).length <= 1) break;
      await this.collect();
      const canAct = i => !P[i].folded && !P[i].allIn;
      const actors = P.filter((p, i) => canAct(i)).length;
      if (actors <= 1 && !revealed) {
        revealed = true; P.forEach(p => { if (!p.folded) p.showCards = true; });
        this.emit({ kind: 'reveal' }); await sleep(900);
      }
      deck.pop();
      for (let k = 0; k < count; k++) this.board.push(deck.pop());
      this.emit({ kind: 'board' }); await sleep(500);
      if (actors >= 2) {
        P.forEach(p => { p.acted = false; });
        this.currentBet = 0; this.minRaise = this.bb;
        await this.bettingRound(nextIdx(this.dealer, canAct));
      } else await sleep(900);
    }
    await this.collect();
    await this.showdown();
  }

  async bettingRound(start) {
    const P = this.seats;
    const needs = p => !p.folded && !p.allIn && (!p.acted || p.bet < this.currentBet);
    let i = start;
    for (let guard = 0; guard < 500; guard++) {
      if (P.filter(p => !p.folded).length <= 1) return;
      if (!P.some(needs)) return;
      const actors = P.filter(p => !p.folded && !p.allIn);
      if (actors.length === 1 && actors[0].bet >= this.currentBet) return;
      const p = P[i];
      if (needs(p)) {
        this.turn = i; this.turnId++;
        let a;
        if (p.isBot) { this.deadline = 0; this.emit({ kind: 'turn' }); await sleep(550 + Math.random() * 750); a = botDecide(this, p); }
        else a = await this.humanAction(p);
        this.turn = -1;
        if (needs(p)) { this.applyAction(i, a); this.emit({ kind: 'action', seat: i, type: p.lastAction, timeout: !!a.timeout }); }
      }
      i = (i + 1) % 5;
    }
  }

  humanAction(p) {
    const auto = timeout => ({ type: this.currentBet - p.bet === 0 ? 'check' : 'fold', timeout });
    if (!p.client) return Promise.resolve(auto(false));
    if (p.away) { this.emit({ kind: 'turn' }); return sleep(700).then(() => auto(false)); }
    return new Promise(res => {
      this.deadline = Date.now() + TURN_TIME;
      const done = a => { clearTimeout(timer); this.actionResolve = null; res(a); };
      const timer = setTimeout(() => {
        p.timeouts = (p.timeouts || 0) + 1;
        if (p.timeouts >= AWAY_AFTER) { p.away = true; this.emit({ kind: 'notice', notice: `${p.name} is sitting out` }); }
        done(auto(true));
      }, TURN_TIME);
      this.actionResolve = (a, fromPlayer) => { if (fromPlayer) p.timeouts = 0; done(a); };
      this.emit({ kind: 'turn' });
    });
  }
  onAct(c, m) {
    const p = this.seats[this.turn];
    if (!this.actionResolve || !p || p.isBot || p.client !== c) return;
    const toCall = this.currentBet - p.bet;
    if (!['fold', 'check', 'call', 'raise'].includes(m.type)) return;
    if (m.type === 'check' && toCall > 0) return;
    this.actionResolve({ type: m.type, to: Math.floor(Number(m.to)) || 0 }, true);
  }

  applyAction(i, a) {
    const P = this.seats, p = P[i], toCall = this.currentBet - p.bet;
    const put = amt => { p.chips -= amt; p.bet += amt; p.total += amt; if (p.chips === 0) p.allIn = true; };
    if (a.type === 'fold') {
      p.folded = true; p.tag = { text: p.isBot || p.client ? 'FOLD' : 'LEFT', cls: 't-fold' }; p.lastAction = 'fold';
    } else if (a.type === 'check' && toCall === 0) {
      p.tag = { text: 'CHECK', cls: 't-check' }; p.lastAction = 'check';
    } else if (a.type !== 'raise' || Math.min(a.to, p.chips + p.bet) <= this.currentBet) {
      put(Math.min(toCall, p.chips)); p.lastAction = 'call';
      p.tag = { text: p.allIn ? 'ALL-IN' : toCall === 0 ? 'CHECK' : 'CALL', cls: p.allIn ? 't-allin' : toCall === 0 ? 't-check' : 't-call' };
    } else {
      const to = Math.min(a.to, p.chips + p.bet), inc = to - this.currentBet, wasBet = this.currentBet === 0;
      if (inc >= this.minRaise) { this.minRaise = inc; P.forEach(q => { if (q !== p) q.acted = false; }); }
      this.currentBet = to; put(to - p.bet); p.lastAction = 'raise';
      p.tag = { text: p.allIn ? 'ALL-IN' : (wasBet ? 'BET ' : 'RAISE ') + short(to), cls: p.allIn ? 't-allin' : 't-raise' };
      if (p.isBot && p.allIn && Math.random() < .4) this.emit({ kind: 'chat', seat: i, text: pick(['All in! 😈', 'Let\'s go!', 'Ship it!']) });
    }
    p.acted = true;
  }

  async collect() {
    const P = this.seats;
    if (P.some(p => p.bet > 0)) { this.emit({ kind: 'collect' }); await sleep(450); }
    P.forEach(p => { p.bet = 0; if (!(p.folded || p.allIn)) p.tag = null; });
    this.emit({ kind: 'state' });
  }

  async showdown() {
    const P = this.seats, live = P.filter(p => !p.folded);
    const total = P.reduce((a, p) => a + p.total, 0);
    if (live.length === 1) {
      const w = live[0], wi = P.indexOf(w);
      w.chips += total; w.tag = { text: 'WIN ' + short(total), cls: 't-win' };
      this.msg = `${w.name} wins ${fmt(total)}`;
      this.emit({ kind: 'win', wins: [{ seat: wi, amt: total }] });
      return;
    }
    live.forEach(p => { p.showCards = true; p.hand = bestHand(p.cards.concat(this.board)); });
    this.emit({ kind: 'reveal' });
    await sleep(700);

    const levels = [...new Set(P.map(p => p.total).filter(t => t > 0))].sort((a, b) => a - b);
    const pots = []; let prev = 0;
    for (const L of levels) {
      const amt = P.reduce((a, p) => a + Math.min(p.total, L) - Math.min(p.total, prev), 0);
      const elig = live.filter(p => p.total >= L);
      if (!elig.length) { if (pots.length) pots[pots.length - 1].amt += amt; else pots.push({ amt, elig: live }); }
      else if (pots.length && pots[pots.length - 1].elig.length === elig.length) pots[pots.length - 1].amt += amt;
      else pots.push({ amt, elig });
      prev = L;
    }
    const won = new Map();
    for (const pot of pots) {
      const best = Math.max(...pot.elig.map(p => p.hand.score));
      const ws = pot.elig.filter(p => p.hand.score === best);
      const share = Math.floor(pot.amt / ws.length);
      ws.forEach((w, k) => won.set(w, (won.get(w) || 0) + share + (k === 0 ? pot.amt - share * ws.length : 0)));
    }
    live.forEach(p => { p.tag = { text: p.hand.name, cls: 't-hand' }; });
    this.emit({ kind: 'state' });
    await sleep(600);

    const top = [...won.keys()].sort((a, b) => b.hand.score - a.hand.score)[0];
    this.winCards = top.hand.cards;
    const wins = [], names = [];
    won.forEach((amt, w) => {
      w.chips += amt; w.tag = { text: 'WIN ' + short(amt), cls: 't-win' };
      wins.push({ seat: P.indexOf(w), amt }); names.push(w.name);
    });
    this.msg = `${names.join(' & ')} ${names.length > 1 ? 'win' : 'wins'} with ${top.hand.name}`;
    this.emit({ kind: 'showdown', wins });
    const humanWinner = wins.find(w => !P[w.seat].isBot);
    if (humanWinner && Math.random() < .5) {
      const loser = live.find(p => p.isBot && !won.has(p));
      if (loser) this.emit({ kind: 'chat', seat: P.indexOf(loser), text: pick(['Nice hand', 'No way!', 'Wow!']) });
    }
    await sleep(1400);
  }

  onChat(c, text) {
    if (!CHAT.includes(text)) return;
    const now = Date.now();
    if (now - (c.lastChat || 0) < 1500) return;
    c.lastChat = now;
    let seat = this.seats.findIndex(p => !p.isBot && p.client === c);
    if (seat < 0) seat = this.seats.findIndex(p => p.reservedBy === c);
    if (seat < 0) return;
    this.emit({ kind: 'chat', seat, text });
    if (Math.random() < .55) {
      const bots = this.seats.map((p, i) => i).filter(i => this.seats[i].isBot && !this.seats[i].reservedBy);
      if (bots.length) setTimeout(() => this.emit({ kind: 'chat', seat: pick(bots), text: pick(REPLIES[text]) }), 700 + Math.random() * 800);
    }
  }
  onRebuy(c) {
    const p = this.seats.find(q => !q.isBot && q.client === c);
    if (this.mode === 'cash' && p && p.chips <= 0 && (!this.inHand || p.sitOut)) { p.chips = this.buy; this.emit({ kind: 'state' }); }
  }
  onBack(c) {
    const p = this.seats.find(q => !q.isBot && q.client === c);
    if (p && p.away) { p.away = false; p.timeouts = 0; this.emit({ kind: 'notice', notice: `${p.name} is back` }); }
  }
}

function botDecide(t, p) {
  const P = t.seats, opp = P.filter(q => q !== p && !q.folded).length;
  const toCall = t.currentBet - p.bet, potAll = P.reduce((a, q) => a + q.total, 0);
  const potOdds = toCall > 0 ? toCall / (potAll + toCall) : 0;
  let eq = equity(p.cards, t.board, opp, 200);
  eq += (Math.random() - .5) * .08 + (p.loose - 1) * .06;
  const thr = b => b / (1 + .45 * (opp - 1));
  const others = P.some(q => q !== p && !q.folded && !q.allIn);
  const maxTo = p.chips + p.bet, r = Math.random(), A = p.aggr;
  const call = () => toCall > 0 ? { type: 'call' } : { type: 'check' };
  const fold = () => toCall > 0 ? { type: 'fold' } : { type: 'check' };
  const raise = frac => {
    if (!others) return call();
    let to = t.currentBet + Math.max(t.minRaise, Math.round((potAll + toCall) * frac / t.sb) * t.sb);
    if (to >= maxTo * .75) to = maxTo;
    return { type: 'raise', to: Math.min(to, maxTo) };
  };
  if (eq >= thr(.85) && others && r < .25 * A) return { type: 'raise', to: maxTo };
  if (eq >= thr(.72)) return r < .7 * A ? raise(.6 + Math.random() * .5) : call();
  if (eq >= thr(.56)) {
    if (toCall === 0) return r < .45 * A ? raise(.5) : call();
    if (eq > potOdds + .05 || toCall <= t.bb * 2) return r < .15 * A ? raise(.7) : call();
    return fold();
  }
  if (eq >= thr(.42) || eq > potOdds + .04) {
    if (toCall === 0) return r < .12 * A ? raise(.5) : call();
    return eq > potOdds ? call() : fold();
  }
  if (toCall === 0) return r < .07 * A ? raise(.6) : call();
  if (toCall <= t.bb && t.board.length === 0 && r < .35 * p.loose) return call();
  return fold();
}

// ---------------------------------------------------------------- clients
function identify(c, m) {
  c.name = String(m.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 12) || 'Player';
  c.avatar = AVATARS.includes(m.avatar) ? m.avatar : '🙂';
}
const clampStage = (v, n) => Math.max(0, Math.min(n - 1, Math.floor(Number(v)) || 0));
function leaveEverything(c) {
  if (c.table) c.table.removeClient(c);
  leaveQueue(c);
}

const queues = SNG_BUYS.map(() => []);
function broadcastQueue(stage) {
  const players = queues[stage].map(c => ({ name: c.name, avatar: c.avatar }));
  for (const c of queues[stage]) send(c, { t: 'queue', stage, players });
}
function leaveQueue(c) {
  if (c.queue == null) return;
  const stage = c.queue, q = queues[stage], i = q.indexOf(c);
  if (i >= 0) q.splice(i, 1);
  c.queue = null;
  broadcastQueue(stage);
}
function onSngJoin(c, m) {
  leaveEverything(c);
  const stage = clampStage(m.stage, SNG_BUYS.length);
  identify(c, m);
  queues[stage].push(c); c.queue = stage;
  if (queues[stage].length < SNG_PLAYERS) { broadcastQueue(stage); return; }
  const group = queues[stage].splice(0, SNG_PLAYERS);
  group.forEach(x => { x.queue = null; send(x, { t: 'joined', mode: 'sng', stage }); });
  broadcastQueue(stage);
  const t = new Table(stage, 'sng', group);
  t.emit({ kind: 'state', notice: 'The tournament is starting. Good luck!' });
  t.run();
}

function onJoin(c, m) {
  leaveEverything(c);
  const stage = clampStage(m.stage, CASH.length);
  identify(c, m);
  const t = [...tables.values()].find(x => x.mode === 'cash' && x.stage === stage && x.freeSeat() >= 0) || new Table(stage);
  t.addClient(c);
}
function onMessage(c, raw) {
  if (raw.length > MAX_MESSAGE) return;
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  const t = c.table;
  switch (m.t) {
    case 'join': onJoin(c, m); break;
    case 'sngJoin': onSngJoin(c, m); break;
    case 'sngLeave': leaveQueue(c); break;
    case 'act': if (t) t.onAct(c, m); break;
    case 'chat': if (t) t.onChat(c, m.text); break;
    case 'rebuy': if (t) t.onRebuy(c); break;
    case 'back': if (t) t.onBack(c); break;
    case 'leave': if (t) t.removeClient(c); break;
  }
}

// ---------------------------------------------------------------- http + websocket
function findFile(name) {
  for (const dir of [path.join(__dirname, 'public'), path.join(__dirname, '..')]) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
const FILES = { '/': ['TexasHoldem.html', 'text/html; charset=utf-8'], '/index.html': ['TexasHoldem.html', 'text/html; charset=utf-8'],
  '/TexasHoldem.html': ['TexasHoldem.html', 'text/html; charset=utf-8'], '/thumbnail.jpg': ['thumbnail.jpg', 'image/jpeg'] };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') {
    let players = 0;
    for (const t of tables.values()) players += t.humanCount();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, players, tables: tables.size, sng: queues.map(q => q.length) }));
    return;
  }
  const f = FILES[url] && findFile(FILES[url][0]);
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
  // Browsers (phones especially) must check for a new version of the game page on every visit.
  res.writeHead(200, { 'Content-Type': FILES[url][1], 'Cache-Control': f.endsWith('.html') ? 'no-cache, must-revalidate' : 'public, max-age=3600' });
  if (f.endsWith('.html')) {
    // A page served from here should talk to this server, whatever SERVER_URL the file was given.
    res.end(fs.readFileSync(f, 'utf8').replace(/const SERVER_URL = '[^']*';/, "const SERVER_URL = '';"));
  } else fs.createReadStream(f).pipe(res);
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', ws => {
  const c = { ws, table: null };
  ws.on('pong', () => { ws.isDead = false; });
  ws.on('message', data => onMessage(c, data.toString()));
  ws.on('close', () => leaveEverything(c));
  ws.on('error', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isDead) { ws.terminate(); continue; }
    ws.isDead = true; ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`Hold-em Royale server listening on port ${PORT}`));
