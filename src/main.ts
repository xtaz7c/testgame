import Phaser from 'phaser';
import './home.css';
import { gameConfig } from './game/config';
import { BUILD_LABEL } from './buildInfo';

const homeScreen = document.querySelector<HTMLElement>('#home-screen');
const gameContainer = document.querySelector<HTMLElement>('#game-container');
const startButton = document.querySelector<HTMLButtonElement>('#start-game');
const controlsButton = document.querySelector<HTMLButtonElement>('#open-controls');
const controlsDialog = document.querySelector<HTMLDialogElement>('#controls-dialog');
const closeControlsButton = document.querySelector<HTMLButtonElement>('#close-controls');
const buildVersion = document.querySelector<HTMLElement>('#build-version');
const modeDialog = document.querySelector<HTMLDialogElement>('#mode-dialog');
const closeModesButton = document.querySelector<HTMLButtonElement>('#close-modes');
const tutorialButton = document.querySelector<HTMLButtonElement>('#start-tutorial');
const campaignButton = document.querySelector<HTMLButtonElement>('#start-campaign');
const campaignDescription = document.querySelector<HTMLElement>('#campaign-description');
const campaignAction = document.querySelector<HTMLElement>('#campaign-action');

let game: Phaser.Game | null = null;

if (
  !homeScreen ||
  !gameContainer ||
  !startButton ||
  !controlsButton ||
  !controlsDialog ||
  !closeControlsButton ||
  !buildVersion ||
  !modeDialog ||
  !closeModesButton ||
  !tutorialButton ||
  !campaignButton ||
  !campaignDescription ||
  !campaignAction
) {
  throw new Error('Required home screen elements are missing.');
}

buildVersion.textContent = BUILD_LABEL;

function isCampaignUnlocked(): boolean {
  try {
    return window.localStorage.getItem('outbreakzones:campaign-unlocked') === '1';
  } catch {
    return false;
  }
}

function refreshCampaignAvailability(): void {
  const unlocked = isCampaignUnlocked();
  campaignButton!.disabled = !unlocked;
  campaignButton!.setAttribute('aria-disabled', String(!unlocked));
  campaignDescription!.textContent = unlocked
    ? 'Continue a história e defenda o primeiro refúgio da equipe.'
    : 'Conclua o tutorial para desbloquear a campanha e continuar a história.';
  campaignAction!.textContent = unlocked ? 'CONTINUAR CAMPANHA ↗' : 'BLOQUEADO · CONCLUA O TUTORIAL';
}

function startOperation(missionId: 0 | 1): void {
  if (game) return;
  modeDialog!.close();
  startButton!.disabled = true;
  startButton!.setAttribute('aria-busy', 'true');
  startButton!.innerHTML = '<span>PREPARANDO OPERAÇÃO</span><span class="loading-dots" role="status" aria-label="Preparando"><i></i><i></i><i></i></span>';
  homeScreen!.hidden = true;
  gameContainer!.hidden = false;
  game = new Phaser.Game({
    ...gameConfig,
    callbacks: {
      ...gameConfig.callbacks,
      preBoot: (instance) => instance.registry.set('missionId', missionId),
    },
  });
  (window as unknown as { game: Phaser.Game }).game = game;
}

startButton.addEventListener('click', () => {
  if (game) return;
  refreshCampaignAvailability();
  modeDialog!.showModal();
});
tutorialButton!.addEventListener('click', () => startOperation(0));
campaignButton!.addEventListener('click', () => {
  if (isCampaignUnlocked()) startOperation(1);
});
closeModesButton!.addEventListener('click', () => modeDialog!.close());
refreshCampaignAvailability();

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
