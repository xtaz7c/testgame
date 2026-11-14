import Phaser from 'phaser';
import { BUILD_LABEL } from '../../buildInfo';

/** Carrega assets críticos e áudio opcional antes da missão. */
export class BootScene extends Phaser.Scene {
  private failedKeys: string[] = [];
  private failedCriticalKeys: string[] = [];
  private progressBar!: Phaser.GameObjects.Graphics;
  private progressTrack!: Phaser.GameObjects.Graphics;
  private statusText!: Phaser.GameObjects.Text;
  private percentageText!: Phaser.GameObjects.Text;

  constructor() {
    super('BootScene');
  }

  preload(): void {
    const { width, height } = this.scale;
    const centerX = width / 2;
    const centerY = height / 2;
    const barWidth = Math.min(width * 0.46, 560);
    const barHeight = 12;
    const barX = centerX - barWidth / 2;
    const barY = centerY + 112;

    this.cameras.main.setBackgroundColor('#111415');
    this.drawBackdrop(width, height);

    this.add
      .text(width * 0.065, height * 0.075, 'OUTBREAK', {
        fontFamily: 'Barlow Condensed, Impact, sans-serif',
        fontSize: '22px',
        fontStyle: 'bold',
        color: '#e8e3d8',
        letterSpacing: 3,
      })
      .setOrigin(0, 0.5);
    this.add
      .text(width * 0.065 + 132, height * 0.075, 'ZONES', {
        fontFamily: 'Barlow Condensed, Impact, sans-serif',
        fontSize: '22px',
        fontStyle: 'bold',
        color: '#c33a36',
        letterSpacing: 3,
      })
      .setOrigin(0, 0.5);
    this.add
      .text(width * 0.935, height * 0.075, 'PROTOCOLO DE SOBREVIVÊNCIA  /  SETOR 07', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '10px',
        color: '#858a87',
        letterSpacing: 1.5,
      })
      .setOrigin(1, 0.5);
    this.add
      .text(centerX, centerY - 82, 'PREPARANDO OPERAÇÃO', {
        fontFamily: 'Barlow Condensed, Impact, sans-serif',
        fontSize: Math.max(30, Math.min(48, width * 0.026)),
        fontStyle: 'bold',
        color: '#e8e3d8',
        letterSpacing: 2,
      })
      .setOrigin(0.5);
    this.add
      .text(centerX, centerY - 36, 'ESTABELECENDO CONEXÃO COM A ÁREA DE OPERAÇÕES', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '10px',
        color: '#858a87',
        letterSpacing: 1.8,
      })
      .setOrigin(0.5);

    this.progressTrack = this.add.graphics();
    this.progressTrack.fillStyle(0x1b2021, 1);
    this.progressTrack.fillRect(barX, barY, barWidth, barHeight);
    this.progressTrack.lineStyle(1, 0x454b49, 0.9);
    this.progressTrack.strokeRect(barX, barY, barWidth, barHeight);
    this.progressBar = this.add.graphics();

    this.statusText = this.add
      .text(barX, barY + 30, 'CARREGANDO RECURSOS DA MISSÃO', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '9px',
        color: '#a6aaa2',
        letterSpacing: 1.3,
      })
      .setOrigin(0, 0.5);
    this.percentageText = this.add
      .text(barX + barWidth, barY + 30, '0%', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '10px',
        fontStyle: 'bold',
        color: '#c33a36',
      })
      .setOrigin(1, 0.5);

    this.add
      .text(width * 0.065, height * 0.925, `SISTEMA DE CAMPO  //  ${BUILD_LABEL}`, {
        fontFamily: 'Arial, sans-serif',
        fontSize: '8px',
        color: '#666e6a',
        letterSpacing: 1.4,
      })
      .setOrigin(0, 0.5);
    this.add
      .text(width * 0.935, height * 0.925, 'AGUARDE INSTRUÇÕES', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '8px',
        color: '#a72b2e',
        letterSpacing: 1.4,
      })
      .setOrigin(1, 0.5);

    this.load.on('progress', (value: number) => {
      const progress = Phaser.Math.Clamp(value, 0, 1);
      this.progressBar.clear();
      this.progressBar.fillStyle(0xc33a36, 1);
      this.progressBar.fillRect(barX, barY, barWidth * progress, barHeight);
      this.percentageText.setText(`${Math.round(progress * 100)}%`);
    });

    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      this.failedKeys.push(file.key);
      if (file.type !== 'audio') {
        this.failedCriticalKeys.push(file.key);
      }
      console.warn('[BootScene] Falha ao carregar asset:', file.key, file.url);
    });

    this.load.on('complete', () => {
      if (this.failedCriticalKeys.length > 0) {
        this.showLoadFailure(barX, barY, barWidth, barHeight);
      } else if (this.failedKeys.length > 0) {
        this.showOptionalAssetWarning();
      }
    });

    this.load.tilemapTiledJSON('mission-01', '/maps/mission-01.tmj');
    this.load.spritesheet('character-sprites', '/assets/sprites/characters.svg', {
      frameWidth: 32,
      frameHeight: 32,
    });
    this.load.image('mission-tiles', '/assets/tiles/terrain/mission-tiles.svg');

    // Pick one ambient track per mission; avoid downloading unused full-length variants.
    const ambientVariant = Phaser.Math.Between(1, 4);
    const ambientTrackKey = `ambient-loop-${ambientVariant}`;
    const ambientSuffix = String(ambientVariant).padStart(2, '0');
    this.registry.set('ambientTrackKey', ambientTrackKey);
    this.load.audio(
      ambientTrackKey,
      `/audio/music/ambient-suspense-${ambientSuffix}.wav`,
    );

    // Short sound effects keep their per-event variation.
    for (let variant = 1; variant <= 4; variant += 1) {
      const suffix = String(variant).padStart(2, '0');
      this.load.audio(
        `pistol-shot-${variant}`,
        `/audio/effects/weapons/pistol-shot-${suffix}.wav`,
      );
      this.load.audio(
        `infected-groan-${variant}`,
        `/audio/effects/infected/infected-groan-${suffix}.wav`,
      );
    }
  }

  create(): void {
    if (this.failedCriticalKeys.length > 0) {
      return;
    }

    this.scene.start('MissionScene');
  }

  private drawBackdrop(width: number, height: number): void {
    const graphics = this.add.graphics();
    graphics.lineStyle(1, 0xb9b9b0, 0.055);

    for (let x = 0; x <= width; x += 64) {
      graphics.lineBetween(x, 0, x, height);
    }
    for (let y = 0; y <= height; y += 64) {
      graphics.lineBetween(0, y, width, y);
    }

    const radarX = width * 0.77;
    const radarY = height * 0.49;
    graphics.lineStyle(1, 0xa72b2e, 0.16);
    [150, 230, 310].forEach((radius) => graphics.strokeCircle(radarX, radarY, radius));

    graphics.lineStyle(1, 0xc33a36, 0.12);
    graphics.lineBetween(radarX - 350, radarY, radarX + 350, radarY);
    graphics.lineBetween(radarX, radarY - 350, radarX, radarY + 350);

    graphics.lineStyle(2, 0xc33a36, 0.65);
    const corner = 24;
    const inset = 34;
    graphics.lineBetween(inset, inset, inset + corner, inset);
    graphics.lineBetween(inset, inset, inset, inset + corner);
    graphics.lineBetween(width - inset, inset, width - inset - corner, inset);
    graphics.lineBetween(width - inset, inset, width - inset, inset + corner);
    graphics.lineBetween(inset, height - inset, inset + corner, height - inset);
    graphics.lineBetween(inset, height - inset, inset, height - inset - corner);
    graphics.lineBetween(
      width - inset,
      height - inset,
      width - inset - corner,
      height - inset,
    );
    graphics.lineBetween(
      width - inset,
      height - inset,
      width - inset,
      height - inset - corner,
    );
  }

  private showLoadFailure(x: number, y: number, width: number, height: number): void {
    this.progressBar.clear();
    this.progressBar.fillStyle(0xa72b2e, 1);
    this.progressBar.fillRect(x, y, width, height);

    const list = this.failedCriticalKeys.slice(0, 5).join(', ');
    const extra =
      this.failedCriticalKeys.length > 5
        ? ` (+${this.failedCriticalKeys.length - 5})`
        : '';

    this.statusText.setColor('#c33a36');
    this.statusText.setText(
      [
        'FALHA AO CARREGAR RECURSOS DA MISSÃO',
        `ARQUIVOS: ${list}${extra}`,
        'VERIFIQUE O CONSOLE E RECARREGUE A PÁGINA.',
      ].join('\n'),
    );
    this.percentageText.setText('ERRO');
    this.percentageText.setColor('#c33a36');

    console.error(
      '[BootScene] Carregamento concluído com erros. Não iniciando MissionScene.',
      this.failedCriticalKeys,
    );
  }

  private showOptionalAssetWarning(): void {
    this.statusText.setColor('#b9b9b0');
    this.statusText.setText(
      'ÁUDIO INDISPONÍVEL. A OPERAÇÃO CONTINUARÁ SEM EFEITOS SONOROS.',
    );
    console.warn('[BootScene] Assets opcionais indisponíveis:', this.failedKeys);
  }
}
