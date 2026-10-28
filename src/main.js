import { initRankingUI } from "./ranking-client.js";
import { gameState } from "./gameStates.js";
import { img, loadAssets } from "./assets.js";
import { preloadAllAudio, initAudioUnlock } from "./audio.js";
import { initLayout, layout } from "./layout.js";
import { intiGrid, drawGrid, updateFillGridAnim } from "./grid.js";
import { initHand, drawHand } from "./hand.js";
import { initUIEvents } from "./uiEvents.js";
import { drawGhost } from "./blocks.js";
import { updateAndDrawScoring } from "./score.js";
import { drawGameOverScreen, updateSilvering } from "./gameOver.js";
import { drawOptionsDialog } from "./options.js";
import { updateAndDrawParticles, hasParticles } from "./particles.js";
import { updateAndDrawFloatingTexts } from "./floatingText.js";
import { spriteMap } from "./spriteMap.js";
import { requestRender, startRenderLoop } from "./render-loop.js";

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const GAME_WIDTH = gameState.GAME_WIDTH;
const GAME_HEIGHT = gameState.GAME_HEIGHT;

function initCanvas() {
  const dpr = window.devicePixelRatio || 1;

  const stage = document.getElementById("game-stage");
  const scale = Math.min(stage.clientWidth / GAME_WIDTH, stage.clientHeight / GAME_HEIGHT);
  const displayWidth = GAME_WIDTH * scale;
  const displayHeight = GAME_HEIGHT * scale;

  // The artwork uses a 720 by 1280 logical canvas. Avoid oversampling it on tablets.
  const renderScale = Math.min(dpr * scale, 1);
  const width = Math.max(1, Math.round(GAME_WIDTH * renderScale));
  const height = Math.max(1, Math.round(GAME_HEIGHT * renderScale));
  if (canvas.width === width && canvas.height === height &&
      canvas.style.width === `${displayWidth}px` && canvas.style.height === `${displayHeight}px`) return;

  canvas.width = width;
  canvas.height = height;

  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;

  ctx.setTransform(1, 0, 0, 1, 0, 0);

  ctx.scale(width / GAME_WIDTH, height / GAME_HEIGHT);
  requestRender();
}

function drawMenu(ctx) {
  if (!gameState.isMenu()) return;
  const sb = spriteMap.gameUI.startBtn;
  ctx.drawImage(img.plantTop, layout.plantTop.x, layout.plantTop.y);

  ctx.drawImage(img.logo, layout.logo.x, layout.logo.y);

  ctx.save();
  ctx.translate(layout.startBtn.x, layout.startBtn.y);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(
    img.uiSheet,
    sb.sx,
    sb.sy,
    sb.sw,
    sb.sh,
    -sb.sw / 2,
    -sb.sh / 2,
    layout.startBtn.h,
    sb.sh,
  );
  ctx.restore();

  ctx.drawImage(img.plantBottom, layout.plantBottom.x, layout.plantBottom.y);
}

function drawFrame() {
  ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  ctx.drawImage(img.bg, 0, 0);

  drawMenu(ctx);

  if (!gameState.isMenu()) {
    updateAndDrawScoring(ctx);

    if (gameState.isStartAnim()) {
      updateFillGridAnim();
    }
    drawGrid(ctx);
    ctx.drawImage(img.gridOutline, layout.gridOutline.x, layout.gridOutline.y);
    ctx.drawImage(img.bottomBg, layout.bottomBg.x, layout.bottomBg.y);
    ctx.drawImage(img.plantTop, layout.plantTop.x, layout.plantTop.y);
    ctx.drawImage(img.plantBottom, layout.plantBottom.x, layout.plantBottom.y);

    drawGhost(ctx);
    drawHand(ctx);
    updateAndDrawParticles(ctx);
    updateAndDrawFloatingTexts(ctx);
    updateSilvering();

    if(gameState.isOptions()) {
      drawOptionsDialog(ctx)
    }

    if (gameState.isGameOver() && gameState.silveringDone) {
      drawGameOverScreen(ctx);
    }
  }
}

function isAnimating() {
  if (gameState.isMenu()) return false;
  return gameState.isStartAnim() || hasParticles() || gameState.floatingTexts.length > 0 ||
    gameState.displayScore < gameState.score || gameState.displayBestScore < gameState.bestScore ||
    (gameState.silveringActive && !gameState.silveringDone) ||
    (gameState.isOptions() && gameState.optionsAnimProgress < 1) ||
    (gameState.isGameOver() && (gameState.gameOverAnimProgress < 1 || gameState.gameOverDisplayScore < gameState.score));
}

function isPaused() {
  return document.hidden || Boolean(document.querySelector(".community-dialog[open]"));
}

function initGame() {
  initRankingUI();
  loadAssets().then(async () => {
    gameState.init(canvas, ctx, img.uiSheet, img.uiGameSheet);
    initCanvas();
    await preloadAllAudio();
    initAudioUnlock();
    initLayout(img);
    initUIEvents();
    intiGrid(img.gridOutline);
    initHand();
    window.addEventListener("resize", initCanvas);
    window.visualViewport?.addEventListener("resize", initCanvas);
    startRenderLoop({ render: drawFrame, isAnimating, isPaused });
    document.addEventListener("visibilitychange", requestRender);
    window.addEventListener("pageshow", requestRender);
    const dialogs = new MutationObserver(requestRender);
    document.querySelectorAll(".community-dialog").forEach(dialog => {
      dialogs.observe(dialog, { attributes: true, attributeFilter: ["open"] });
    });
    document.fonts?.ready.then(requestRender);
  });
}

initGame();
