import { SHAPES } from "./shapes.js";

export const RULESET = "block-blast-remake-v1";
export const MAX_EVENTS = 14000;
const SIZE = 8;

export function scoreMove(state, placedCells, linesCleared) {
  let clearPoints = 0;
  state.score += placedCells;
  state.lastMoveCleared = linesCleared > 0;
  if (linesCleared > 0) {
    state.movesSinceLastClear = 0;
    state.streak += 1;
    state.streakMultiplier = state.streak;
    const bonuses = [0, 0, 10, 30, 60, 100, 150];
    const bonus = linesCleared <= 6 ? bonuses[linesCleared] : 150 + (linesCleared - 6) * 50;
    clearPoints = (linesCleared * 10 + bonus) * state.streakMultiplier;
    state.score += clearPoints;
  } else {
    state.movesSinceLastClear += 1;
    if (state.movesSinceLastClear >= 3) {
      state.streak = 0;
      state.streakMultiplier = 1;
      state.movesSinceLastClear = 0;
    }
  }
  return {
    placementPoints: placedCells,
    clearPoints,
    linesCleared,
    totalEarned: placedCells + clearPoints,
    streak: state.streak,
    comboMultiplier: state.streakMultiplier,
    total: state.score,
  };
}

function fits(board, shape, row, col) {
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const y = row + r;
      const x = col + c;
      if (y < 0 || y >= SIZE || x < 0 || x >= SIZE || board[y][x]) return false;
    }
  }
  return true;
}

function fitsAnywhere(board, name) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (fits(board, SHAPES[name], r, c)) return true;
    }
  }
  return false;
}

export function validateReplay(events, claimedScore) {
  if (!Array.isArray(events) || events.length < 2 || events.length > MAX_EVENTS) {
    throw new Error("This game has an invalid or unsupported replay length.");
  }
  const board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  const state = { score: 0, streak: 0, streakMultiplier: 1, movesSinceLastClear: 0 };
  let hand = [];
  let moves = 0;
  for (const event of events) {
    if (!Array.isArray(event)) throw new Error("Invalid replay event.");
    if (event[0] === "deal") {
      const names = event[1];
      if (event.length !== 2 || hand.some(Boolean) || !Array.isArray(names) ||
          ![1, 3].includes(names.length) ||
          names.some(name => typeof name !== "string" || !Object.hasOwn(SHAPES, name)) ||
          (names.length === 1 && names[0] !== "DOT")) {
        throw new Error("Invalid block tray.");
      }
      hand = names.slice();
      continue;
    }
    const [, slot, row, col] = event;
    if (event[0] !== "move" || event.length !== 4 ||
        ![slot, row, col].every(Number.isInteger) || slot < 0 || slot >= hand.length ||
        !hand[slot] || row < 0 || row >= SIZE || col < 0 || col >= SIZE) {
      throw new Error("Invalid block placement.");
    }
    const shape = SHAPES[hand[slot]];
    if (!fits(board, shape, row, col)) throw new Error("A block overlaps or leaves the board.");
    let cells = 0;
    shape.forEach((line, r) => line.forEach((cell, c) => {
      if (cell) { board[row + r][col + c] = 1; cells += 1; }
    }));
    hand[slot] = null;
    const rows = [];
    const cols = [];
    for (let i = 0; i < SIZE; i++) {
      if (board[i].every(Boolean)) rows.push(i);
      if (board.every(line => line[i])) cols.push(i);
    }
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (rows.includes(r) || cols.includes(c)) board[r][c] = 0;
      }
    }
    scoreMove(state, cells, rows.length + cols.length);
    moves += 1;
  }
  if (!moves || !Number.isSafeInteger(claimedScore) || claimedScore !== state.score) {
    throw new Error("The submitted score does not match the replay.");
  }
  const remaining = hand.filter(Boolean);
  if (!remaining.length || remaining.some(name => fitsAnywhere(board, name))) {
    throw new Error("Finish the game before submitting a score.");
  }
  return { score: state.score, moves };
}
