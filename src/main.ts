import Phaser from 'phaser';
import './styles/index.css';
import { gameConfig } from './game/config';
import { BUILD_LABEL } from './buildInfo';

const homeScreen = document.querySelector<HTMLElement>('#home-screen');
const gameContainer = document.querySelector<HTMLElement>('#game-container');
const startButton = document.querySelector<HTMLButtonElement>('#start-game');
const controlsButton = document.querySelector<HTMLButtonElement>('#open-controls');
const controlsDialog = document.querySelector<HTMLDialogElement>('#controls-dialog');
const closeControlsButton = document.querySelector<HTMLButtonElement>('#close-controls');
const buildVersion = document.querySelector<HTMLElement>('#build-version');

let game: Phaser.Game | null = null;

if (
  !homeScreen ||
  !gameContainer ||
  !startButton ||
  !controlsButton ||
  !controlsDialog ||
  !closeControlsButton ||
  !buildVersion
) {
  throw new Error('Required home screen elements are missing.');
}

buildVersion.textContent = BUILD_LABEL;

startButton.addEventListener('click', () => {
  if (game) return;

  startButton.disabled = true;
  startButton.setAttribute('aria-busy', 'true');
  startButton.innerHTML = `
    <span>PREPARANDO OPERAÇÃO</span>
    <span class="loading-dots" role="status" aria-label="Carregando">
      <i></i><i></i><i></i>
    </span>
  `;
  homeScreen.hidden = true;
  gameContainer.hidden = false;

  game = new Phaser.Game(gameConfig);
  (window as unknown as { game: Phaser.Game }).game = game;
});

window.addEventListener('outbreakzones:return-home', () => {
  game?.destroy(true);
  game = null;
  gameContainer.hidden = true;
  homeScreen.hidden = false;
  startButton.disabled = false;
  startButton.removeAttribute('aria-busy');
  startButton.innerHTML = `
    <span>INICIAR OPERAÇÃO</span>
    <span class="primary-button__arrow" aria-hidden="true">↗</span>
  `;
});

controlsButton.addEventListener('click', () => {
  controlsDialog.showModal();
});

closeControlsButton.addEventListener('click', () => {
  controlsDialog.close();
});
