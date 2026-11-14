import Phaser from 'phaser';
import { AudioManager } from '../audio/AudioManager';
import { DEFAULT_HUD_SCALE, normalizeHudScale } from '../HudScale';
import { canStartCampaign, getMissionDefinition, getMissionResultMessage, type MissionId } from '../MissionProgression';
import { Simulation } from '../../simulation/Simulation';
import type { CombatEvent } from '../../simulation/systems/CombatSystem';
import { GridMap } from '../../simulation/world/GridMap';
import type { TilePosition } from '../../simulation/world/WorldConfig';
import { buildGridFromTiledLayers } from '../../simulation/world/WorldMapLoader';
import { getAvailableEntryPoints, MISSION_ENTRY_POINTS } from '../../simulation/world/MissionEntryPoints';
import { BuildingSystem, type AccessKind } from '../../simulation/systems/buildings/BuildingSystem';
import type { WaveSpawnPoint } from '../../simulation/systems/WaveSystem';
import type { MaintenanceAction, MaintenanceState } from '../../simulation/systems/buildings/BuildingMaintenanceSystem';
import { DeployableStructureSystem, type DeployableKind, type DeployableState } from '../../simulation/systems/buildings/DeployableStructureSystem';

const CAMERA_SPEED = 600;
const MIN_CAMERA_ZOOM = 0.5;
const MAX_CAMERA_ZOOM = 2.5;
const SELECTION_DRAG_THRESHOLD = 8;
const MISSION_SEED_STORAGE_KEY = 'outbreakzones:mission-seed';
const CAMPAIGN_UNLOCK_STORAGE_KEY = 'outbreakzones:campaign-unlocked';
const BUILDING_STATE_STORAGE_PREFIX = 'outbreakzones:building-state:';
const MAINTENANCE_STATE_STORAGE_PREFIX = 'outbreakzones:maintenance-state:';
const DEPLOYABLE_STATE_STORAGE_PREFIX = 'outbreakzones:deployable-state:';

interface TacticalOfficer {
  readonly id: number;
  readonly container: Phaser.GameObjects.Container;
  readonly selectionRing: Phaser.GameObjects.Arc;
  readonly sprite: Phaser.GameObjects.Sprite;
}

interface TacticalCivilian {
  readonly id: number;
  readonly container: Phaser.GameObjects.Container;
  readonly sprite: Phaser.GameObjects.Sprite;
  lastX: number;
  lastY: number;
}

interface TacticalInfected {
  readonly id: number;
  readonly container: Phaser.GameObjects.Container;
  readonly sprite: Phaser.GameObjects.Sprite;
}

interface MinimapVisibility {
  officers: boolean;
  civilians: boolean;
  infected: boolean;
}

const MINIMAP_CONFIG_KEY = 'outbreakzones:minimap-visibility';
const HUD_SCALE_STORAGE_KEY = 'outbreakzones:hud-scale';
const HUD_COLORS = {
  ink: 0x111415,
  panel: 0x101516,
  metal: 0xb9b9b0,
  muted: 0xc0c5bd,
  paper: 0xe8e3d8,
  red: 0xc33a36,
  officer: 0x5c9be6,
  civilian: 0xe7c66a,
  infected: 0xc33a36,
} as const;

export class MissionScene extends Phaser.Scene {
  private simulation!: Simulation;
  private audio!: AudioManager;
  private readonly playedCombatEvents = new WeakSet<CombatEvent>();
  private cameraKeys!: Record<string, Phaser.Input.Keyboard.Key>;
  private selectionGraphics!: Phaser.GameObjects.Graphics;
  private combatGraphics!: Phaser.GameObjects.Graphics;
  private accessGraphics!: Phaser.GameObjects.Graphics;
  private buildingSystem!: BuildingSystem;
  private deployableGraphics!: Phaser.GameObjects.Graphics;
  private placementMode: DeployableKind | null = null;
  private selectedDeployableId: number | null = null;
  private buildStatus = '';
  private readonly buildButtons: Phaser.GameObjects.Text[] = [];
  private officers: TacticalOfficer[] = [];
  private readonly infectedVisuals = new Map<number, TacticalInfected>();
  private readonly civilianVisuals = new Map<number, TacticalCivilian>();
  private debugInfectedSpawnIndex = 0;
  private selectedOfficerIds = new Set<number>();
  private worldGrid!: GridMap;
  private worldMap!: Phaser.Tilemaps.Tilemap;
  private tileSize = 32;
  private cameraWorldWidth = 0;
  private cameraWorldHeight = 0;
  private selectionStart: { x: number; y: number; screenX: number; screenY: number } | null = null;
  private isPaused = false;
  private resultPanel!: Phaser.GameObjects.Rectangle;
  private resultText!: Phaser.GameObjects.Text;
  private resultHomeButton!: Phaser.GameObjects.Text;
  private resultCampaignButton!: Phaser.GameObjects.Text;
  private resultRestartButton!: Phaser.GameObjects.Text;
  private missionId: MissionId = 0;
  private resultShown = false;
  private lastPersistedBuildingState = '';
  private lastPersistedMaintenanceState = '';
  private lastPersistedDeployableState = '';
  private hudRoot!: Phaser.GameObjects.Container;
  private hudScale = DEFAULT_HUD_SCALE;
  private hudScaleDownButton!: Phaser.GameObjects.Text;
  private hudScaleUpButton!: Phaser.GameObjects.Text;
  private hudPanels!: Phaser.GameObjects.Graphics;
  private minimapGraphics!: Phaser.GameObjects.Graphics;
  private missionText!: Phaser.GameObjects.Text;
  private missionToggle!: Phaser.GameObjects.Text;
  private missionPanel!: Phaser.GameObjects.Graphics;
  private waveText!: Phaser.GameObjects.Text;
  private dateTimeText!: Phaser.GameObjects.Text;
  private readonly officerStatusIcons: Array<{ container: Phaser.GameObjects.Container; graphics: Phaser.GameObjects.Graphics; label: Phaser.GameObjects.Text; id: number }> = [];
  private missionPanelVisible = false;
  private settingsButton!: Phaser.GameObjects.Text;
  private fullscreenButton!: Phaser.GameObjects.Text;
  private pauseOverlay!: Phaser.GameObjects.Rectangle;
  private pausePanel!: Phaser.GameObjects.Rectangle;
  private pauseTitle!: Phaser.GameObjects.Text;
  private pauseSubtitle!: Phaser.GameObjects.Text;
  private resumeButton!: Phaser.GameObjects.Text;
  private resetButton!: Phaser.GameObjects.Text;
  private settingsMenuButton!: Phaser.GameObjects.Text;
  private homeButton!: Phaser.GameObjects.Text;
  private settingsBackButton!: Phaser.GameObjects.Text;
  private pauseSettingsOpen = false;
  private officerToggle!: Phaser.GameObjects.Text;
  private civilianToggle!: Phaser.GameObjects.Text;
  private infectedToggle!: Phaser.GameObjects.Text;
  private minimapVisibility: MinimapVisibility = {
    officers: true,
    civilians: true,
    infected: true,
  };
  private pauseMenuOpen = false;
  private readonly hudBounds = {
    settings: { x: 20, y: 20, width: 124, height: 56 },
    mission: { x: 20, y: 88, width: 276, height: 184 },
    minimap: { x: 0, y: 20, width: 258, height: 242 },

    team: { x: 0, y: 0, width: 160, height: 112 },
    build: { x: 20, y: 0, width: 280, height: 112 },
  };

  constructor() {
    super('MissionScene');
  }

  create(): void {
    // Scene restarts reuse this scene instance; discard entity visuals keyed by old simulation IDs.
    this.infectedVisuals.clear();
    this.civilianVisuals.clear();
    this.officers = [];
    this.isPaused = false;
    this.resultShown = false;
    this.selectedOfficerIds.clear();
    this.debugInfectedSpawnIndex = 0;
    this.placementMode = null;
    this.selectedDeployableId = null;
    this.buildStatus = '';
    this.missionId = this.registry.get('missionId') === 1 ? 1 : 0;
    this.hudScale = normalizeHudScale(this.readStorage(HUD_SCALE_STORAGE_KEY));
    this.simulation = new Simulation();
    this.audio = new AudioManager(this);
    this.audio.startAmbient();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.audio.destroy());
    this.createCharacterAnimations();
    this.createWorld();
    this.createOfficers();
    this.createCivilians();
    this.createHud();
    this.createCameraControls();
    this.createSelectionControls();
    this.input.keyboard?.on('keydown-I', () => this.spawnDebugInfected());
    this.input.keyboard?.on('keydown-N', () => this.emitNoiseAtHouse());
    this.input.keyboard?.on('keydown-E', () => this.interactWithNearestAccess());
    this.input.keyboard?.on('keydown-B', () => this.breachNearestAccess());
    this.input.keyboard?.on('keydown-Y', () => this.startMaintenance('repair'));
    this.input.keyboard?.on('keydown-U', () => this.startMaintenance('reinforce'));
    this.input.keyboard?.on('keydown-V', () => this.startMaintenance('barricade'));
    this.input.keyboard?.on('keydown-L', () => this.startMaintenance('upgrade-lock'));
    this.input.keyboard?.on('keydown-H', () => this.setSelectedPosture('hold_fire'));
    this.input.keyboard?.on('keydown-G', () => this.setSelectedPosture('engage'));
    this.input.keyboard?.on('keydown-X', () => this.holdSelectedPositions());
    this.input.keyboard?.on('keydown-M', () => this.audio.toggleMute());
    this.input.keyboard?.on('keydown-R', () => {
      if (this.simulation.getState().missionStatus !== 'playing') this.restartMission();
    });

    this.input.keyboard?.on('keydown-SPACE', () => {
      if (this.simulation.getState().missionStatus !== 'playing') return;
      this.setPausedFromKeyboard();
    });

    this.updateHud();
  }

  update(_time: number, delta: number): void {
    const dt = Math.min(delta / 1000, 0.05);
    this.simulation.update(dt);
    this.updateCombatFeedback();
    this.updateMissionResult();
    this.persistBuildingState();
    this.persistMaintenanceState();
    this.persistDeployableState();
    this.updateCamera(dt);
    this.clampCamera();
    if (!this.isPaused) {
      this.updateOfficers(dt);
    }
    this.updateInfectedVisuals();
    this.updateCivilianVisuals();
    this.updateAccessVisuals();
    this.updateDeployableVisuals();
    this.updateHud();
  }

  private createWorld(): void {
    const map = this.make.tilemap({ key: 'mission-01' });
    this.worldMap = map;
    const tileset = map.addTilesetImage('mission-tiles', 'mission-tiles');

    if (!tileset) {
      throw new Error('Unable to attach the mission tileset to the Tiled map.');
    }

    for (const layerName of ['Ground', 'Terrain', 'Structures']) {
      const layer = map.createLayer(layerName, tileset, 0, 0);
      if (!layer) {
        throw new Error(`Required Tiled layer "${layerName}" is missing.`);
      }
    }

    this.tileSize = map.tileWidth;
    this.createRuralUtilityLines();
    this.worldGrid = buildGridFromTiledLayers(
      map.width,
      map.height,
      map.tileWidth,
      [map.getObjectLayer('Collision'), map.getObjectLayer('Obstacles')],
    );

    const entrances = map.getObjectLayer('Entrances');
    const definitions = (entrances?.objects ?? []).flatMap((object) => {
      const kind = object.type as AccessKind;
      if (!['door', 'window', 'garage'].includes(kind)) return [];
      const { x, y, width, height } = object;
      if (
        typeof x !== 'number' || !Number.isFinite(x) ||
        typeof y !== 'number' || !Number.isFinite(y) ||
        typeof width !== 'number' || !Number.isFinite(width) || width <= 0 ||
        typeof height !== 'number' || !Number.isFinite(height) || height <= 0
      ) return [];
      const health = object.properties?.health;
      return [{
        id: object.name || `access-${object.id}`,
        kind,
        x,
        y,
        width,
        height,
        ...(typeof health === 'number' ? { maxHealth: health } : {}),
      }];
    });
    const configuredSeed = this.registry.get('missionSeed');
    const storedSeed = this.readStoredMissionSeed();
    const missionSeed = typeof configuredSeed === 'number' && Number.isInteger(configuredSeed)
      ? configuredSeed
      : storedSeed ?? Date.now();
    this.registry.set('missionSeed', missionSeed);
    this.writeStorage(MISSION_SEED_STORAGE_KEY, String(missionSeed));
    this.simulation.setRandomSeed(missionSeed);
    this.buildingSystem = new BuildingSystem(definitions, this.worldGrid, this.tileSize, missionSeed);
    const savedBuildingState = this.readStorage(`${BUILDING_STATE_STORAGE_PREFIX}${missionSeed}`);
    if (savedBuildingState) {
      try {
        this.buildingSystem.restoreState(JSON.parse(savedBuildingState) as ReturnType<BuildingSystem['exportState']>);
      } catch {
        this.removeStorage(`${BUILDING_STATE_STORAGE_PREFIX}${missionSeed}`);
      }
    }
    this.lastPersistedBuildingState = JSON.stringify(this.buildingSystem.exportState());
    this.simulation.setBuildingSystem(this.buildingSystem);
    const savedMaintenanceState = this.readStorage(`${MAINTENANCE_STATE_STORAGE_PREFIX}${missionSeed}`);
    if (savedMaintenanceState) {
      try {
        this.simulation.restoreMaintenanceState(JSON.parse(savedMaintenanceState) as MaintenanceState);
      } catch {
        this.removeStorage(`${MAINTENANCE_STATE_STORAGE_PREFIX}${missionSeed}`);
      }
    }
    this.lastPersistedMaintenanceState = this.serializeMaintenanceState();
    this.registry.set('worldGrid', this.worldGrid);
    this.simulation.setWorldGrid(this.worldGrid, this.tileSize);
    this.simulation.setDeployableSystem(new DeployableStructureSystem(this.worldGrid, this.tileSize));
    const savedDeployableState = this.readStorage(`${DEPLOYABLE_STATE_STORAGE_PREFIX}${missionSeed}`);
    if (savedDeployableState) {
      try {
        this.simulation.restoreDeployableState(JSON.parse(savedDeployableState) as DeployableState);
      } catch {
        this.removeStorage(`${DEPLOYABLE_STATE_STORAGE_PREFIX}${missionSeed}`);
      }
    }
    this.lastPersistedDeployableState = this.serializeDeployableState();
    this.deployableGraphics = this.add.graphics().setDepth(95);
    // A van fica no início da rua rural sem saída, abaixo da propriedade.
    this.simulation.setExtractionZone({ x: 1936, y: 2032, radius: 72 });
    this.createPoliceSafeZone(1936, 2032);
    const spawnPoints: WaveSpawnPoint[] = [
      { id: 'west', x: -48, y: 1504, entryTile: { column: 8, row: 47 } },
      { id: 'east', x: 3888, y: 1504, entryTile: { column: 111, row: 47 } },
      { id: 'north', x: 1936, y: -48, entryTile: { column: 60, row: 8 } },
      { id: 'south', x: 1936, y: 2928, entryTile: { column: 60, row: 82 } },
    ];
    const mission = getMissionDefinition(this.missionId);
    this.simulation.configureWaves(
      spawnPoints,
      mission.waves,
      mission.preparationDuration,
      mission.requiresCivilianExtraction,
    );
    this.cameraWorldWidth = map.widthInPixels;
    this.cameraWorldHeight = map.heightInPixels;
    this.cameras.main
      .setBounds(0, 0, this.cameraWorldWidth, this.cameraWorldHeight)
      .setZoom(1)
      // O foco inicial do Tutorial é a casa principal, não o centro geométrico do mapa.
      .centerOn(1024, 608);
  }

  private createPoliceSafeZone(x: number, y: number): void {
    const zone = this.add.graphics().setDepth(69);
    zone.fillStyle(0x55c878, 0.08);
    zone.fillCircle(x, y, 72);
    zone.lineStyle(3, 0x55c878, 0.9);
    zone.strokeCircle(x, y, 72);

    // Van policial vista de cima: a área de extração fica centrada no veículo.
    const van = this.add.graphics().setPosition(x, y).setDepth(72);
    van.fillStyle(0x101516, 1);
    van.fillRoundedRect(-35, -21, 70, 42, 6);
    van.fillStyle(0xd8d8d0, 1);
    van.fillRoundedRect(-31, -18, 62, 36, 4);
    van.fillStyle(0x303a40, 1);
    van.fillRoundedRect(13, -14, 13, 28, 2);
    van.fillStyle(0x8fb6c4, 0.95);
    van.fillRoundedRect(16, -11, 7, 22, 1);
    van.fillStyle(0xc33a36, 1);
    van.fillRect(-29, -5, 42, 5);
    van.fillStyle(0x356fa7, 1);
    van.fillRect(-29, 0, 42, 5);
    van.fillStyle(0x161a1b, 1);
    van.fillRoundedRect(-25, -24, 15, 5, 2);
    van.fillRoundedRect(10, -24, 15, 5, 2);
    van.fillRoundedRect(-25, 19, 15, 5, 2);
    van.fillRoundedRect(10, 19, 15, 5, 2);
    van.fillStyle(0xe8e3d8, 1);
    van.fillRect(-31, -13, 3, 7);
    van.fillRect(-31, 6, 3, 7);

    this.add.text(x, y - 48, 'ZONA DE RESGATE', {
      fontFamily: 'Arial, sans-serif',
      fontSize: '10px',
      fontStyle: 'bold',
      color: '#8ee0a5',
      backgroundColor: '#101516',
      padding: { x: 6, y: 4 },
    }).setOrigin(0.5).setDepth(73);
  }

  private createRuralUtilityLines(): void {
    const graphics = this.add.graphics().setDepth(88);
    const poleY = 56 * 32 + 16;
    const westPoleX = 52 * 32 + 16;
    const eastPoleX = 68 * 32 + 16;
    graphics.lineStyle(2, 0x292b27, 0.95);
    graphics.lineBetween(westPoleX, poleY - 52, eastPoleX, poleY - 52);
    graphics.lineStyle(4, 0x5a4935, 1);
    [westPoleX, eastPoleX].forEach((x) => graphics.lineBetween(x, poleY - 34, x, poleY + 30));
    graphics.lineStyle(2, 0x92734a, 1);
    [westPoleX, eastPoleX].forEach((x) => graphics.lineBetween(x - 8, poleY - 34, x + 8, poleY - 34));
  }

  private readStorage(key: string): string | null {
    try {
      return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private writeStorage(key: string, value: string): void {
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
    } catch {
      // Storage can be unavailable in private browsing or restricted contexts.
    }
  }

  private removeStorage(key: string): void {
    try {
      if (typeof window !== 'undefined') window.localStorage.removeItem(key);
    } catch {
      // Storage can be unavailable in private browsing or restricted contexts.
    }
  }

  private readStoredMissionSeed(): number | null {
    const raw = this.readStorage(MISSION_SEED_STORAGE_KEY);
    if (!raw) return null;
    const seed = Number(raw);
    return Number.isInteger(seed) ? seed : null;
  }

  private persistBuildingState(): void {
    if (!this.buildingSystem) return;
    const serialized = JSON.stringify(this.buildingSystem.exportState());
    if (serialized === this.lastPersistedBuildingState) return;
    const seed = this.registry.get('missionSeed');
    if (typeof seed !== 'number' || !Number.isInteger(seed)) return;
    this.writeStorage(`${BUILDING_STATE_STORAGE_PREFIX}${seed}`, serialized);
    this.lastPersistedBuildingState = serialized;
  }

  private serializeMaintenanceState(): string {
    const state = this.simulation.getMaintenanceState();
    if (!state) return '';
    return JSON.stringify({
      resources: state.resources,
      jobs: state.jobs.map((job) => ({ ...job, remaining: Math.ceil(job.remaining) })),
    });
  }

  private persistMaintenanceState(): void {
    const serialized = this.serializeMaintenanceState();
    if (!serialized || serialized === this.lastPersistedMaintenanceState) return;
    const seed = this.registry.get('missionSeed');
    if (typeof seed !== 'number' || !Number.isInteger(seed)) return;
    this.writeStorage(`${MAINTENANCE_STATE_STORAGE_PREFIX}${seed}`, serialized);
    this.lastPersistedMaintenanceState = serialized;
  }

  private serializeDeployableState(): string {
    const state = this.simulation.getDeployableState();
    return state ? JSON.stringify(state) : '';
  }

  private persistDeployableState(): void {
    const serialized = this.serializeDeployableState();
    if (!serialized || serialized === this.lastPersistedDeployableState) return;
    const seed = this.registry.get('missionSeed');
    if (typeof seed !== 'number' || !Number.isInteger(seed)) return;
    this.writeStorage(`${DEPLOYABLE_STATE_STORAGE_PREFIX}${seed}`, serialized);
    this.lastPersistedDeployableState = serialized;
  }

  private restartMission(): void {
    const seed = this.registry.get('missionSeed');
    if (typeof seed === 'number' && Number.isInteger(seed)) {
      this.removeStorage(`${BUILDING_STATE_STORAGE_PREFIX}${seed}`);
      this.removeStorage(`${MAINTENANCE_STATE_STORAGE_PREFIX}${seed}`);
      this.removeStorage(`${DEPLOYABLE_STATE_STORAGE_PREFIX}${seed}`);
    }
    this.removeStorage(MISSION_SEED_STORAGE_KEY);
    this.registry.remove('missionSeed');
    this.scene.restart();
  }

  private createCharacterAnimations(): void {
    const animations = [
      { key: 'police-walk', start: 1, end: 2 },
      { key: 'civilian-walk', start: 7, end: 8 },
      { key: 'infected-walk', start: 13, end: 14 },
    ];
    for (const animation of animations) {
      if (this.anims.exists(animation.key)) continue;
      this.anims.create({
        key: animation.key,
        frames: this.anims.generateFrameNumbers('character-sprites', {
          start: animation.start,
          end: animation.end,
        }),
        frameRate: 7,
        repeat: -1,
      });
    }
  }

  private playCharacterWalk(sprite: Phaser.GameObjects.Sprite, animation: string): void {
    if (sprite.anims.currentAnim?.key !== animation) {
      sprite.play(animation);
    }
  }

  private setCharacterFrame(sprite: Phaser.GameObjects.Sprite, frame: number): void {
    sprite.anims.stop();
    sprite.setFrame(frame);
  }

  private createOfficers(): void {
    this.officers = this.simulation.getOfficers().map((officer) => {
      const position = officer.position;
      const ring = this.add.circle(0, 0, 15).setStrokeStyle(3, 0xffdf70).setVisible(false);
      const sprite = this.add.sprite(0, 0, 'character-sprites', 0)
        .setOrigin(0.5)
        .setScale(1.15);
      const label = this.add.text(0, 16, String(officer.id), {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#ffffff',
        backgroundColor: '#172033',
        padding: { x: 3, y: 1 },
      }).setOrigin(0.5, 0);
      const container = this.add.container(position.x, position.y, [ring, sprite, label]).setDepth(100);
      return { id: officer.id, container, selectionRing: ring, sprite };
    });
  }

  private createCivilians(): void {
    for (const civilian of this.simulation.getCivilians()) {
      const position = civilian.position;
      const sprite = this.add.sprite(0, 0, 'character-sprites', 6)
        .setOrigin(0.5)
        .setScale(1.15);
      const label = this.add.text(0, 16, `C${civilian.id}`, {
        fontFamily: 'monospace',
        fontSize: '9px',
        color: '#ffffff',
        backgroundColor: '#493b1c',
        padding: { x: 3, y: 1 },
      }).setOrigin(0.5, 0);
      const container = this.add.container(position.x, position.y, [sprite, label])
        .setDepth(105);
      this.civilianVisuals.set(civilian.id, {
        id: civilian.id, container, sprite, lastX: position.x, lastY: position.y,
      });
    }
  }

  private updateCivilianVisuals(): void {
    for (const civilian of this.simulation.getCivilians()) {
      const visual = this.civilianVisuals.get(civilian.id);
      if (!visual) continue;
      const position = civilian.position;
      const moving = Math.hypot(position.x - visual.lastX, position.y - visual.lastY) > 0.1;
      visual.lastX = position.x;
      visual.lastY = position.y;
      visual.container.setPosition(position.x, position.y);
      visual.container.setAlpha(civilian.state === 'extracted' ? 0.45 : civilian.isIncapacitated ? 0.55 : 1);
      if (civilian.isIncapacitated) {
        this.setCharacterFrame(visual.sprite, 11);
      } else if (civilian.mood === 'panicked') {
        this.setCharacterFrame(visual.sprite, 10);
      } else if (moving) {
        this.playCharacterWalk(visual.sprite, 'civilian-walk');
      } else {
        this.setCharacterFrame(visual.sprite, 6);
      }
    }
  }

  private createHud(): void {
    const width = this.scale.width;
    const height = this.scale.height;
    const logicalWidth = width / this.hudScale;
    const logicalHeight = height / this.hudScale;
    const mapX = logicalWidth - 274;
    const mapY = 20;
    const buildX = (logicalWidth - 280) / 2;
    const buildY = logicalHeight - 132;

    this.hudBounds.settings.x = 20;
    this.hudBounds.settings.y = 20;
    this.hudBounds.mission.x = 20;
    this.hudBounds.mission.y = 88;
    this.hudBounds.minimap.x = mapX;
    this.hudBounds.minimap.width = 258;
    this.hudBounds.minimap.height = 242;
    this.hudBounds.minimap.y = mapY;
    this.hudBounds.team.x = mapX;
    this.hudBounds.team.y = mapY + 242;
    this.hudBounds.team.width = 238;
    this.hudBounds.team.height = 160;
    this.hudBounds.build.x = buildX;
    this.hudBounds.build.y = buildY;

    this.hudPanels = this.add.graphics().setScrollFactor(0).setDepth(1500);
    this.minimapGraphics = this.add.graphics().setScrollFactor(0).setDepth(1502);
    this.missionPanel = this.add.graphics().setScrollFactor(0).setDepth(1501).setVisible(false);
    this.selectionGraphics = this.add.graphics().setScrollFactor(0).setDepth(999);
    this.combatGraphics = this.add.graphics().setDepth(120);
    this.accessGraphics = this.add.graphics().setDepth(80);

    this.hudPanels.fillStyle(HUD_COLORS.panel, 0.99);
    this.hudPanels.lineStyle(1, HUD_COLORS.metal, 0.62);
    this.hudPanels.fillRoundedRect(20, 20, 124, 56, 8);
    this.hudPanels.strokeRoundedRect(20, 20, 124, 56, 8);
    this.hudPanels.fillStyle(0x000000, 1);
    this.hudPanels.fillRoundedRect(mapX - 2, mapY - 2, 242, 242, 7);
    this.hudPanels.fillStyle(0x000000, 1);
    this.hudPanels.fillRoundedRect(mapX, mapY, 238, 238, 5);

    this.settingsButton = this.add.text(48, 48, '⚙', {
      fontFamily: 'Arial, sans-serif', fontSize: '29px', color: '#e8e3d8',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1505).setInteractive({ useHandCursor: true });
    this.settingsButton.on('pointerdown', () => this.openPauseMenu());

    this.fullscreenButton = this.add.text(112, 48, '⛶', {
      fontFamily: 'Arial, sans-serif', fontSize: '27px', color: '#e8e3d8',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1505).setInteractive({ useHandCursor: true });
    this.fullscreenButton.setData('action-label', 'Entrar em tela cheia');
    this.fullscreenButton.on('pointerdown', () => this.toggleFullscreen());
    this.scale.on('enterfullscreen', () => this.fullscreenButton.setText('×').setData('action-label', 'Sair da tela cheia'));
    this.scale.on('leavefullscreen', () => this.fullscreenButton.setText('⛶').setData('action-label', 'Entrar em tela cheia'));

    this.missionToggle = this.add.text(20, 88, '▸  MISSÃO', {
      fontFamily: 'Arial, sans-serif', fontSize: '11px', fontStyle: 'bold',
      color: '#e8e3d8', backgroundColor: '#101516', padding: { x: 12, y: 10 }, fixedWidth: 150,
    }).setScrollFactor(0).setDepth(1505).setInteractive({ useHandCursor: true });
    this.missionToggle.on('pointerdown', () => {
      this.missionPanelVisible = !this.missionPanelVisible;
      this.missionToggle.setText(this.missionPanelVisible ? '▾  MISSÃO' : '▸  MISSÃO');
      this.missionPanel.setVisible(this.missionPanelVisible);
      this.missionText.setVisible(this.missionPanelVisible);
    });
    this.missionPanel.fillStyle(HUD_COLORS.panel, 0.97);
    this.missionPanel.lineStyle(1, HUD_COLORS.red, 0.8);
    this.missionPanel.fillRoundedRect(20, 124, 276, 142, 8);
    this.missionPanel.strokeRoundedRect(20, 124, 276, 142, 8);
    this.missionText = this.add.text(36, 138, '', {
      fontFamily: 'Arial, sans-serif', fontSize: '11px', color: '#f4f1e9',
      lineSpacing: 5, wordWrap: { width: 244 },
    }).setScrollFactor(0).setDepth(1505).setVisible(false);

    // Minimap without heading or legend: its black frame is sufficient.
    this.minimapGraphics.fillStyle(0x080c0d, 1);
    this.minimapGraphics.fillRect(mapX + 6, mapY + 6, 226, 226);
    this.waveText = this.add.text(mapX + 119, mapY + 248, '', {
      fontFamily: 'Arial, sans-serif', fontSize: '10px', fontStyle: 'bold',
      color: '#f4f1e9', backgroundColor: '#101516', padding: { x: 8, y: 7 },
      fixedWidth: 238, align: 'center',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(1505);

    // One real second advances one in-game minute; this clock appears only in Campaign.
    this.dateTimeText = this.add.text(logicalWidth / 2, 24, '', {
      fontFamily: 'Arial, sans-serif', fontSize: '12px', fontStyle: 'bold',
      color: '#f4f1e9', backgroundColor: '#101516', padding: { x: 12, y: 8 },
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(1505).setVisible(this.missionId === 1);

    this.officerStatusIcons.splice(0, this.officerStatusIcons.length);
    [1, 2, 3].forEach((id, index) => {
      const graphics = this.add.graphics();
      const label = this.add.text(0, -1, String(id), {
        fontFamily: 'Arial, sans-serif', fontSize: '10px', fontStyle: 'bold', color: '#ffffff',
      }).setOrigin(0.5);
      const container = this.add.container(mapX + 74 + index * 45, mapY + 314, [graphics, label])
        .setScrollFactor(0).setDepth(1506).setSize(36, 42).setInteractive({ useHandCursor: true });
      container.on('pointerdown', () => this.selectOfficer(id));
      this.officerStatusIcons.push({ container, graphics, label, id });
    });

    // Construction controls are presented as a 2×2 quadrant.
    this.hudPanels.fillStyle(HUD_COLORS.panel, 0.98);
    this.hudPanels.lineStyle(1, HUD_COLORS.metal, 0.55);
    this.hudPanels.fillRoundedRect(buildX, buildY, 280, 112, 8);
    this.hudPanels.strokeRoundedRect(buildX, buildY, 280, 112, 8);
    this.hudPanels.fillStyle(HUD_COLORS.red, 0.95);
    this.hudPanels.fillRect(buildX + 10, buildY + 5, 260, 2);
    this.buildButtons.splice(0, this.buildButtons.length,
      this.createBuildButton(buildX + 78, buildY + 38, 'ABRIGO 30/8', 'shelter-tent'),
      this.createBuildButton(buildX + 202, buildY + 38, 'SUPR. 20/5', 'resource-tent'),
      this.createBuildButton(buildX + 78, buildY + 82, 'SNIPER 45/20', 'sniper-post'),
      this.createBuildButton(buildX + 202, buildY + 82, 'BARREIRA 12/3', 'barricade'),
    );

    this.hudRoot = this.add.container(0, 0).setScrollFactor(0).setDepth(1500);
    this.hudRoot.add([
      this.hudPanels, this.missionPanel, this.minimapGraphics, this.settingsButton,
      this.fullscreenButton, this.missionToggle, this.missionText, this.waveText, this.dateTimeText,
      ...this.officerStatusIcons.map((item) => item.container), ...this.buildButtons,
    ]);
    this.applyHudScale();
    this.refreshBuildButtons();
    this.scale.on('resize', () => this.applyHudScale());

    this.pauseOverlay = this.add.rectangle(width / 2, height / 2, width, height, 0x080a0a, 0.72)
      .setScrollFactor(0).setDepth(1900).setVisible(false);
    this.pausePanel = this.add.rectangle(width / 2, height / 2, 410, 440, HUD_COLORS.panel, 1)
      .setScrollFactor(0).setDepth(1901).setStrokeStyle(1, HUD_COLORS.red, 0.8).setVisible(false);
    this.pauseTitle = this.add.text(width / 2, height / 2 - 188, 'OPERAÇÃO PAUSADA', {
      fontFamily: 'Barlow Condensed, Impact, sans-serif', fontSize: '32px',
      fontStyle: 'bold', color: '#e8e3d8', letterSpacing: 1.5,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1902).setVisible(false);
    this.pauseSubtitle = this.add.text(width / 2, height / 2 - 148, 'ESCOLHA UMA AÇÃO', {
      fontFamily: 'Arial, sans-serif', fontSize: '9px', color: '#858a87', letterSpacing: 1.4,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1902).setVisible(false);
    this.hudScaleDownButton = this.createPauseAction(width / 2, height / 2 - 108, '', () => this.adjustHudScale(-0.05));
    this.hudScaleUpButton = this.createPauseAction(width / 2, height / 2 - 56, '', () => this.adjustHudScale(0.05));
    this.officerToggle = this.createPauseToggle(width / 2, height / 2 + 2, 'POLICIAIS', 'officers');
    this.civilianToggle = this.createPauseToggle(width / 2, height / 2 + 52, 'CIVIS', 'civilians');
    this.infectedToggle = this.createPauseToggle(width / 2, height / 2 + 102, 'INFECTADOS', 'infected');
    this.resumeButton = this.createPauseAction(width / 2, height / 2 - 90, 'CONTINUAR', () => this.closePauseMenu());
    this.resetButton = this.createPauseAction(width / 2, height / 2 - 30, 'REINICIAR MISSÃO', () => this.restartMission());
    this.settingsMenuButton = this.createPauseAction(width / 2, height / 2 + 30, 'CONFIGURAÇÕES', () => {
      this.pauseSettingsOpen = true;
      this.setPauseMenuVisible(true);
    });
    this.homeButton = this.createPauseAction(width / 2, height / 2 + 90, 'VOLTAR AO INÍCIO', () => this.returnToHome());
    this.settingsBackButton = this.createPauseAction(width / 2, height / 2 + 152, 'VOLTAR', () => {
      this.pauseSettingsOpen = false;
      this.setPauseMenuVisible(true);
    });
    this.resultPanel = this.add.rectangle(width / 2, height / 2, 540, 250, HUD_COLORS.panel, 0.98)
      .setScrollFactor(0).setDepth(2000).setStrokeStyle(2, HUD_COLORS.red, 0.85).setVisible(false);
    this.resultText = this.add.text(width / 2, height / 2 - 48, '', {
      fontFamily: 'Barlow Condensed, Impact, sans-serif', fontSize: '26px',
      color: '#e8e3d8', align: 'center', lineSpacing: 8, wordWrap: { width: 460 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2001).setVisible(false);
    this.resultHomeButton = this.createResultAction(width / 2 - 135, height / 2 + 82, 'VOLTAR AO INÍCIO', () => this.returnToHome());
    this.resultCampaignButton = this.createResultAction(width / 2 + 135, height / 2 + 82, 'INICIAR CAMPANHA', () => this.startCampaign());
    this.resultRestartButton = this.createResultAction(width / 2, height / 2 + 82, 'JOGAR NOVAMENTE', () => this.restartMission());

    this.loadMinimapVisibility();
    this.refreshPauseMenuLabels();
  }

  private createBuildButton(x: number, y: number, label: string, kind: DeployableKind): Phaser.GameObjects.Text {
    const button = this.add.text(x, y, label, {
      fontFamily: 'Arial, sans-serif',
      fontSize: '8px',
      fontStyle: 'bold',
      color: '#e8e3d8',
      backgroundColor: '#252c2d',
      padding: { x: 6, y: 8 },
      fixedWidth: 96,
      align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1506)
      .setInteractive({ useHandCursor: true });
    button.on('pointerdown', () => {
      this.placementMode = this.placementMode === kind ? null : kind;
      this.buildStatus = this.placementMode ? 'CLIQUE NO MAPA PARA POSICIONAR' : '';
      this.refreshBuildButtons();
      this.updateHud();
    });
    return button;
  }

  private refreshBuildButtons(): void {
    const kinds: DeployableKind[] = ['shelter-tent', 'resource-tent', 'sniper-post', 'barricade'];
    this.buildButtons.forEach((button, index) => {
      const kind = kinds[index];
      button.setBackgroundColor(this.placementMode === kind ? '#a72b2e' : '#252c2d');
    });
  }

  private placeDeployableAt(worldX: number, worldY: number): void {
    if (!this.placementMode) return;
    const tile = {
      column: Math.floor(worldX / this.tileSize),
      row: Math.floor(worldY / this.tileSize),
    };
    const placed = this.simulation.placeDeployable(this.placementMode, tile);
    if (!placed) {
      this.buildStatus = 'SEM RECURSOS OU POSIÇÃO INVÁLIDA';
      this.updateHud();
      return;
    }
    this.selectedDeployableId = placed.id;
    this.placementMode = null;
    this.buildStatus = 'ESTRUTURA POSICIONADA';
    this.refreshBuildButtons();
    this.persistDeployableState();
    this.updateDeployableVisuals();
    this.updateHud();
  }

  private dismantleSelectedDeployable(): void {
    if (this.selectedDeployableId === null) return;
    const dismantled = this.simulation.dismantleDeployable(this.selectedDeployableId);
    if (dismantled) {
      this.selectedDeployableId = null;
      this.buildStatus = 'ESTRUTURA DESMONTADA · 50% DOS MATERIAIS RECUPERADOS';
      this.persistDeployableState();
      this.updateDeployableVisuals();
      this.updateHud();
    }
  }

  private updateDeployableVisuals(): void {
    if (!this.deployableGraphics || !this.simulation) return;
    this.deployableGraphics.clear();
    for (const structure of this.simulation.getDeployableSnapshots()) {
      const { x, y } = structure.position;
      const color = structure.isDestroyed ? 0x626967 : structure.kind === 'shelter-tent'
        ? 0xd8b56a : structure.kind === 'resource-tent'
          ? 0x8f9d7b : structure.kind === 'sniper-post' ? 0x6e9cbe : 0xa5aaa5;
      this.deployableGraphics.fillStyle(color, structure.isDestroyed ? 0.35 : 0.95);
      if (structure.kind === 'shelter-tent') {
        this.deployableGraphics.fillTriangle(x - 14, y + 8, x, y - 12, x + 14, y + 8);
        this.deployableGraphics.fillRect(x - 12, y + 8, 24, 10);
      } else if (structure.kind === 'resource-tent') {
        this.deployableGraphics.fillRoundedRect(x - 12, y - 10, 24, 20, 3);
        this.deployableGraphics.lineStyle(2, 0x26302a, 0.9);
        this.deployableGraphics.strokeRect(x - 12, y - 10, 24, 20);
      } else if (structure.kind === 'sniper-post') {
        this.deployableGraphics.fillCircle(x, y, 12);
        this.deployableGraphics.lineStyle(3, 0x1c2930, 1);
        this.deployableGraphics.lineBetween(x, y, x + 18, y - 8);
      } else {
        this.deployableGraphics.fillRect(x - 15, y - 9, 30, 18);
        this.deployableGraphics.lineStyle(2, 0x252c2d, 1);
        this.deployableGraphics.strokeRect(x - 15, y - 9, 30, 18);
      }
      if (this.selectedDeployableId === structure.id) {
        this.deployableGraphics.lineStyle(2, HUD_COLORS.paper, 0.95);
        this.deployableGraphics.strokeCircle(x, y, 20);
      }
      this.deployableGraphics.fillStyle(0x111415, 0.9);
      this.deployableGraphics.fillRect(x - 14, y + 20, 28, 4);
      this.deployableGraphics.fillStyle(0x72b879, 1);
      this.deployableGraphics.fillRect(x - 14, y + 20, 28 * (structure.health / structure.maxHealth), 4);
    }
  }

  private createResultAction(
    x: number,
    y: number,
    label: string,
    action: () => void,
  ): Phaser.GameObjects.Text {
    const button = this.add.text(x, y, label, {
      fontFamily: 'Arial, sans-serif',
      fontSize: '10px',
      fontStyle: 'bold',
      color: '#fff5e9',
      backgroundColor: '#252c2d',
      padding: { x: 14, y: 12 },
      fixedWidth: 230,
      align: 'center',
      letterSpacing: 0.8,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2002).setVisible(false)
      .setInteractive({ useHandCursor: true });
    button.on('pointerdown', action);
    return button;
  }

  private startCampaign(): void {
    const unlocked = this.readStorage(CAMPAIGN_UNLOCK_STORAGE_KEY) === '1';
    if (!canStartCampaign(this.missionId, this.simulation.getState().missionStatus, unlocked)) return;
    this.writeStorage(CAMPAIGN_UNLOCK_STORAGE_KEY, '1');
    this.removeStorage(MISSION_SEED_STORAGE_KEY);
    this.registry.remove('missionSeed');
    this.registry.set('missionId', 1);
    this.scene.restart();
  }

  private createPauseAction(
    x: number,
    y: number,
    label: string,
    action: () => void,
  ): Phaser.GameObjects.Text {
    const button = this.add.text(x, y, label, {
      fontFamily: 'Arial, sans-serif',
      fontSize: '12px',
      fontStyle: 'bold',
      color: '#fff5e9',
      backgroundColor: '#252c2d',
      padding: { x: 22, y: 12 },
      fixedWidth: 280,
      align: 'center',
      letterSpacing: 1,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1902).setVisible(false)
      .setInteractive({ useHandCursor: true });
    button.on('pointerdown', action);
    return button;
  }

  private createPauseToggle(
    x: number,
    y: number,
    label: string,
    key: keyof MinimapVisibility,
  ): Phaser.GameObjects.Text {
    const toggle = this.add.text(x, y, label, {
      fontFamily: 'Arial, sans-serif',
      fontSize: '11px',
      color: '#e8e3d8',
      backgroundColor: '#252c2d',
      padding: { x: 16, y: 10 },
      fixedWidth: 230,
      align: 'left',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1902).setVisible(false)
      .setInteractive({ useHandCursor: true });
    toggle.on('pointerdown', () => {
      this.minimapVisibility[key] = !this.minimapVisibility[key];
      this.saveMinimapVisibility();
      this.refreshPauseMenuLabels();
      this.updateHud();
    });
    return toggle;
  }

  private loadMinimapVisibility(): void {
    const saved = this.readStorage(MINIMAP_CONFIG_KEY);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as Partial<MinimapVisibility>;
      this.minimapVisibility = {
        officers: parsed.officers !== false,
        civilians: parsed.civilians !== false,
        infected: parsed.infected !== false,
      };
    } catch {
      this.minimapVisibility = { officers: true, civilians: true, infected: true };
    }
  }

  private saveMinimapVisibility(): void {
    this.writeStorage(MINIMAP_CONFIG_KEY, JSON.stringify(this.minimapVisibility));
  }

  private refreshPauseMenuLabels(): void {
    const label = (name: string, enabled: boolean) => `${name}     [${enabled ? 'ATIVO' : 'OCULTO'}]`;
    this.officerToggle.setText(label('POLICIAIS', this.minimapVisibility.officers));
    this.civilianToggle.setText(label('CIVIS', this.minimapVisibility.civilians));
    this.infectedToggle.setText(label('INFECTADOS', this.minimapVisibility.infected));
    const percentage = Math.round(this.hudScale * 100);
    this.hudScaleDownButton.setText(`HUD ${percentage}%  /  DIMINUIR`);
    this.hudScaleUpButton.setText(`HUD ${percentage}%  /  AUMENTAR`);
  }

  private applyHudScale(): void {
    if (!this.hudRoot) return;
    // Anchor the left panels to the left edge and compute the right/bottom
    // panel coordinates in scaled space so neither side clips at 80%–120%.
    this.hudRoot.setScale(this.hudScale).setPosition(0, 0);
  }

  private adjustHudScale(delta: number): void {
    this.hudScale = normalizeHudScale(this.hudScale + delta);
    this.writeStorage(HUD_SCALE_STORAGE_KEY, String(this.hudScale));
    this.applyHudScale();
    this.refreshPauseMenuLabels();
  }

  private openPauseMenu(): void {
    if (this.simulation.getState().missionStatus !== 'playing' || this.pauseMenuOpen) return;
    this.pauseMenuOpen = true;
    this.pauseSettingsOpen = false;
    this.isPaused = true;
    this.simulation.setPaused(true);
    this.setPauseMenuVisible(true);
  }

  private returnToHome(): void {
    window.dispatchEvent(new Event('outbreakzones:return-home'));
  }

  private closePauseMenu(): void {
    this.pauseMenuOpen = false;
    this.isPaused = false;
    this.simulation.setPaused(false);
    this.setPauseMenuVisible(false);
  }

  private setPauseMenuVisible(visible: boolean): void {
    [
      this.pauseOverlay, this.pausePanel, this.pauseTitle, this.pauseSubtitle,
    ].forEach((object) => object.setVisible(visible));
    const mainActions = [this.resumeButton, this.resetButton, this.settingsMenuButton, this.homeButton];
    const settingsActions = [
      this.hudScaleDownButton, this.hudScaleUpButton,
      this.officerToggle, this.civilianToggle, this.infectedToggle, this.settingsBackButton,
    ];
    mainActions.forEach((object) => object.setVisible(visible && !this.pauseSettingsOpen));
    settingsActions.forEach((object) => object.setVisible(visible && this.pauseSettingsOpen));
    this.pauseSubtitle.setText(this.pauseSettingsOpen ? 'ESCALA DO HUD E VISIBILIDADE DO MINIMAPA' : 'ESCOLHA UMA AÇÃO');
  }

  private setPausedFromKeyboard(): void {
    if (this.pauseMenuOpen) {
      this.closePauseMenu();
      return;
    }
    this.openPauseMenu();
  }

  private selectAllOfficers(): void {
    this.selectedOfficerIds.clear();
    for (const officer of this.simulation.getOfficers()) {
      if (!officer.isIncapacitated) this.selectedOfficerIds.add(officer.id);
    }
    this.refreshSelectionVisuals();
  }

  private isHudPoint(x: number, y: number): boolean {
    const localX = x / this.hudScale;
    const localY = y / this.hudScale;
    const inside = (rect: { x: number; y: number; width: number; height: number }) =>
      localX >= rect.x && localX <= rect.x + rect.width &&
      localY >= rect.y && localY <= rect.y + rect.height;
    const missionArea = this.missionPanelVisible ? inside(this.hudBounds.mission) :
      (localX >= this.hudBounds.mission.x && localX <= this.hudBounds.mission.x + 150 &&
       localY >= this.hudBounds.mission.y && localY <= this.hudBounds.mission.y + 36);
    return inside(this.hudBounds.settings) || missionArea ||
      inside(this.hudBounds.minimap) || inside(this.hudBounds.team) || inside(this.hudBounds.build) ||
      this.pauseMenuOpen;
  }

  private updateHud(): void {
    if (!this.simulation || !this.minimapGraphics) return;
    const state = this.simulation.getState();
    const civilians = this.simulation.getCivilians();
    const officers = this.simulation.getOfficers();
    const waveLabel = state.wavePhase === 'preparing'
      ? `ONDA ${state.waveNumber || 1}  ·  ${state.preparationRemaining.toFixed(0)}s`
      : `ONDA ${state.waveNumber || 1} / ${state.totalWaves}`;
    const civilianStates = {
      sheltered: civilians.filter((civilian) => civilian.state === 'sheltered').length,
      following: civilians.filter((civilian) => civilian.state === 'following').length,
      extracted: civilians.filter((civilian) => civilian.state === 'extracted').length,
    };
    const objective = state.missionStatus === 'victory'
      ? 'MISSÃO CONCLUÍDA'
      : state.missionStatus === 'defeat'
        ? 'EQUIPE INCAPACITADA'
        : 'RESGATAR SOBREVIVENTES';
    this.missionText.setText([
      `MISSÃO ${this.missionId}  /  ${getMissionDefinition(this.missionId).title.toUpperCase()}`,
      objective,
      `RESGATE  ${state.rescuedCivilianCount} / ${state.civilianCount}`,
      `CIVIS  ${civilianStates.sheltered} AGUARDANDO · ${civilianStates.following} ESCOLTANDO · ${civilianStates.extracted} EXTRAÍDOS`,
      `AMEAÇAS ATIVAS  ${state.infectedCount}`,
    ].join('\n'));

    const elapsedCampaignMinutes = 17 * 60 + Math.floor(state.elapsed);
    const campaignDay = Math.floor(elapsedCampaignMinutes / (24 * 60)) + 1;
    const minuteOfDay = elapsedCampaignMinutes % (24 * 60);
    const campaignHour = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
    const campaignMinute = String(minuteOfDay % 60).padStart(2, '0');
    this.dateTimeText.setVisible(this.missionId === 1);
    if (this.missionId === 1) this.dateTimeText.setText(`DIA ${campaignDay}  ·  ${campaignHour}:${campaignMinute}`);
    this.waveText.setText(waveLabel);

    this.officerStatusIcons.forEach(({ graphics, label, id }) => {
      const officer = officers.find((candidate) => candidate.id === id);
      if (!officer) return;
      const incapacitated = officer.isIncapacitated;
      const selected = this.selectedOfficerIds.has(id) && !incapacitated;
      const fill = incapacitated ? 0x626967 : selected ? 0x8fc4ff : HUD_COLORS.officer;
      const points = [
        { x: -12, y: -13 }, { x: 12, y: -13 }, { x: 11, y: 5 },
        { x: 0, y: 15 }, { x: -11, y: 5 },
      ];
      graphics.clear();
      graphics.fillStyle(fill, 1);
      graphics.lineStyle(selected ? 2 : 1, selected ? HUD_COLORS.paper : 0x000000, 0.95);
      graphics.fillPoints(points, true);
      graphics.strokePoints(points, true);
      label.setColor(incapacitated ? '#a7aaa6' : '#ffffff');
    });

    this.minimapGraphics.clear();
    const mapX = this.hudBounds.minimap.x + 6;
    const mapY = this.hudBounds.minimap.y + 6;
    const mapWidth = 226;
    const mapHeight = 226;
    const mapScale = Math.min(mapWidth / this.worldMap.width, mapHeight / this.worldMap.height);
    const renderedMapWidth = this.worldMap.width * mapScale;
    const renderedMapHeight = this.worldMap.height * mapScale;
    const renderedMapX = mapX + (mapWidth - renderedMapWidth) / 2;
    const renderedMapY = mapY + (mapHeight - renderedMapHeight) / 2;
    const minimapTileColors = [
      0x46583a, 0x414749, 0x796346, 0x77796f,
      0x806849, 0x8a887d, 0x344b31, 0x555b58,
      0x4b5b3b, 0x3d5036, 0x555a3d, 0x394b35,
      0x3c4446, 0x484e4e, 0x4d5552, 0x625c4e,
    ];
    this.minimapGraphics.fillStyle(0x080c0d, 1);
    this.minimapGraphics.fillRect(mapX, mapY, mapWidth, mapHeight);

    // Renderiza a geometria real do Tiled em escala, mantendo a proporção 80×45.
    for (const layerName of ['Ground', 'Terrain', 'Structures']) {
      const layer = this.worldMap.getLayer(layerName);
      if (!layer) continue;
      for (let row = 0; row < layer.data.length; row += 1) {
        const tiles = layer.data[row] ?? [];
        for (let column = 0; column < tiles.length; column += 1) {
          const tile = tiles[column];
          if (!tile || tile.index < 0) continue;
          const color = minimapTileColors[tile.index] ?? 0x555b58;
          this.minimapGraphics.fillStyle(color, 1);
          this.minimapGraphics.fillRect(
            renderedMapX + column * mapScale,
            renderedMapY + row * mapScale,
            mapScale + 0.15,
            mapScale + 0.15,
          );
        }
      }
    }

    const toMinimap = (position: { x: number; y: number }) => ({
      x: renderedMapX + Phaser.Math.Clamp(position.x / this.cameraWorldWidth, 0, 1) * renderedMapWidth,
      y: renderedMapY + Phaser.Math.Clamp(position.y / this.cameraWorldHeight, 0, 1) * renderedMapHeight,
    });

    if (this.minimapVisibility.civilians) {
      for (const civilian of civilians) {
        if (civilian.state === 'extracted') continue;
        const point = toMinimap(civilian.position);
        this.minimapGraphics.fillStyle(HUD_COLORS.civilian, 1);
        this.minimapGraphics.fillCircle(point.x, point.y, 3.5);
      }
    }
    if (this.minimapVisibility.infected) {
      for (const infected of this.simulation.getInfected()) {
        const point = toMinimap(infected.position);
        this.minimapGraphics.fillStyle(HUD_COLORS.infected, 1);
        this.minimapGraphics.fillCircle(point.x, point.y, 3.5);
      }
    }
    if (this.minimapVisibility.officers) {
      for (const officer of officers) {
        const point = toMinimap(officer.position);
        this.minimapGraphics.fillStyle(officer.isIncapacitated ? HUD_COLORS.muted : HUD_COLORS.officer, 1);
        this.minimapGraphics.fillCircle(point.x, point.y, this.selectedOfficerIds.has(officer.id) ? 5 : 4);
        if (this.selectedOfficerIds.has(officer.id)) {
          this.minimapGraphics.lineStyle(1, HUD_COLORS.paper, 0.95);
          this.minimapGraphics.strokeCircle(point.x, point.y, 7);
        }
      }
    }

    // A van policial é o ponto fixo de extração (Safe Zone) no minimapa.
    const safeZonePoint = toMinimap({ x: 1280, y: 1216 });
    this.minimapGraphics.lineStyle(1.5, 0x55c878, 0.95);
    this.minimapGraphics.strokeCircle(safeZonePoint.x, safeZonePoint.y, 5);
    this.minimapGraphics.fillStyle(0x55c878, 1);
    this.minimapGraphics.fillCircle(safeZonePoint.x, safeZonePoint.y, 2);

    const camera = this.cameras.main;
    const viewX = renderedMapX + Phaser.Math.Clamp(camera.scrollX / this.cameraWorldWidth, 0, 1) * renderedMapWidth;
    const viewY = renderedMapY + Phaser.Math.Clamp(camera.scrollY / this.cameraWorldHeight, 0, 1) * renderedMapHeight;
    const viewWidth = Phaser.Math.Clamp((camera.width / camera.zoom) / this.cameraWorldWidth * renderedMapWidth, 2, renderedMapWidth);
    const viewHeight = Phaser.Math.Clamp((camera.height / camera.zoom) / this.cameraWorldHeight * renderedMapHeight, 2, renderedMapHeight);
    this.minimapGraphics.lineStyle(1, HUD_COLORS.paper, 0.9);
    this.minimapGraphics.strokeRect(
      Phaser.Math.Clamp(viewX, renderedMapX, renderedMapX + renderedMapWidth - viewWidth),
      Phaser.Math.Clamp(viewY, renderedMapY, renderedMapY + renderedMapHeight - viewHeight),
      viewWidth,
      viewHeight,
    );

    this.settingsButton.setColor(this.pauseMenuOpen ? '#c33a36' : '#e8e3d8');
  }

  private createCameraControls(): void {
    const keyboard = this.input.keyboard;
    if (!keyboard) return;

    this.cameraKeys = keyboard.addKeys(
      'W,A,S,D,UP,DOWN,LEFT,RIGHT',
    ) as Record<string, Phaser.Input.Keyboard.Key>;

    keyboard.on('keydown-F', () => this.toggleFullscreen());

  }

  private createSelectionControls(): void {
    const keyboard = this.input.keyboard;
    if (!keyboard) return;

    keyboard.on('keydown-ONE', () => this.selectOfficer(1));
    keyboard.on('keydown-TWO', () => this.selectOfficer(2));
    keyboard.on('keydown-THREE', () => this.selectOfficer(3));
    keyboard.on('keydown-DELETE', () => this.dismantleSelectedDeployable());

    this.input.mouse?.disableContextMenu();

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (this.isHudPoint(pointer.x, pointer.y)) return;
      if (this.placementMode && pointer.button === 0) {
        this.placeDeployableAt(pointer.worldX, pointer.worldY);
        return;
      }
      if (pointer.button === 2) {
        if (this.placementMode) {
          this.placementMode = null;
          this.refreshBuildButtons();
          this.buildStatus = 'POSICIONAMENTO CANCELADO';
          this.updateHud();
          return;
        }
        this.issueMoveOrder(pointer.worldX, pointer.worldY);
        return;
      }
      if (pointer.button !== 0) return;

      this.selectionStart = {
        x: pointer.worldX,
        y: pointer.worldY,
        screenX: pointer.x,
        screenY: pointer.y,
      };
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this.selectionStart || !pointer.leftButtonDown()) return;
      this.drawSelectionBox(this.selectionStart.screenX, this.selectionStart.screenY, pointer.x, pointer.y);
    });

    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      if (!this.selectionStart || pointer.button !== 0) return;
      const start = this.selectionStart;
      this.selectionStart = null;
      this.selectionGraphics.clear();

      const distance = Phaser.Math.Distance.Between(start.screenX, start.screenY, pointer.x, pointer.y);
      if (distance >= SELECTION_DRAG_THRESHOLD) {
        this.selectBox(start.x, start.y, pointer.worldX, pointer.worldY, (pointer.event as MouseEvent).shiftKey);
      } else {
        this.selectAt(pointer.worldX, pointer.worldY, (pointer.event as MouseEvent).shiftKey);
      }
    });
  }

  private selectOfficer(id: number): void {
    this.selectedOfficerIds.clear();
    const officer = this.simulation.getOfficers().find((candidate) => candidate.id === id);
    if (officer && !officer.isIncapacitated) this.selectedOfficerIds.add(id);
    this.refreshSelectionVisuals();
  }

  private selectAt(x: number, y: number, additive: boolean): void {
    const hitRadius = 22;
    const hit = [...this.officers]
      .reverse()
      .find((officer) => Phaser.Math.Distance.Between(x, y, officer.container.x, officer.container.y) <= hitRadius);

    if (!additive) this.selectedOfficerIds.clear();
    if (hit && !this.simulation.getOfficers().find((officer) => officer.id === hit.id)?.isIncapacitated) {
      this.selectedDeployableId = null;
      if (additive && this.selectedOfficerIds.has(hit.id)) {
        this.selectedOfficerIds.delete(hit.id);
      } else {
        this.selectedOfficerIds.add(hit.id);
      }
    } else {
      const structure = this.simulation.getDeployableSnapshots()
        .find((candidate) => Phaser.Math.Distance.Between(x, y, candidate.position.x, candidate.position.y) <= 24);
      this.selectedDeployableId = structure?.id ?? null;
      this.updateDeployableVisuals();
    }
    this.refreshSelectionVisuals();
  }

  private selectBox(x1: number, y1: number, x2: number, y2: number, additive: boolean): void {
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);

    if (!additive) this.selectedOfficerIds.clear();
    for (const officer of this.officers) {
      const model = this.simulation.getOfficers().find((candidate) => candidate.id === officer.id);
      if (
        model && !model.isIncapacitated &&
        officer.container.x >= left &&
        officer.container.x <= right &&
        officer.container.y >= top &&
        officer.container.y <= bottom
      ) {
        this.selectedOfficerIds.add(officer.id);
      }
    }
    this.refreshSelectionVisuals();
  }

  private refreshSelectionVisuals(): void {
    for (const officer of this.officers) {
      officer.selectionRing.setVisible(
        this.selectedOfficerIds.has(officer.id) &&
        !this.simulation.getOfficers().find((candidate) => candidate.id === officer.id)?.isIncapacitated,
      );
    }
  }

  private drawSelectionBox(x1: number, y1: number, x2: number, y2: number): void {
    this.selectionGraphics.clear();
    this.selectionGraphics.fillStyle(0x65a9ff, 0.15);
    this.selectionGraphics.lineStyle(1, 0x8fc4ff, 0.95);
    this.selectionGraphics.fillRect(x1, y1, x2 - x1, y2 - y1);
    this.selectionGraphics.strokeRect(x1, y1, x2 - x1, y2 - y1);
  }

  private issueMoveOrder(worldX: number, worldY: number): void {
    const selected = this.simulation.getOfficers().filter(
      (officer) => this.selectedOfficerIds.has(officer.id) && !officer.isIncapacitated,
    );
    const prioritizedTarget = [...this.simulation.getInfected()]
      .reverse()
      .find((infected) => Phaser.Math.Distance.Between(
        worldX, worldY, infected.position.x, infected.position.y,
      ) <= 24);
    if (prioritizedTarget) {
      for (const officer of selected) {
        this.simulation.setTargetPriority(officer.id, prioritizedTarget.id);
      }
      return;
    }
    for (const officer of selected) this.simulation.setTargetPriority(officer.id, null);
    const target = this.worldToTile(worldX, worldY);
    const centerOffset = (selected.length - 1) / 2;
    selected.forEach((officer, index) => {
      const destination = {
        column: Math.round(target.column + index - centerOffset),
        row: target.row,
      };
      this.simulation.issueMoveOrder(officer.id, destination);
    });
  }




  private setSelectedPosture(posture: 'engage' | 'hold_fire'): void {
    for (const officer of this.simulation.getOfficers()) {
      if (this.selectedOfficerIds.has(officer.id)) {
        this.simulation.setOfficerTacticalPosture(officer.id, posture);
      }
    }
  }

  private holdSelectedPositions(): void {
    for (const officer of this.simulation.getOfficers()) {
      if (this.selectedOfficerIds.has(officer.id)) {
        this.simulation.holdOfficerPosition(officer.id);
      }
    }
  }

  private emitNoiseAtHouse(): void {
    const entry = MISSION_ENTRY_POINTS.find((point) => point.id === 'front-door');
    if (!entry) return;
    const target = this.buildingSystem.getInfectedTarget(entry.id, entry.approachTile, entry.breachTile);
    if (target) this.simulation.emitNoiseAtStructure(target, 1000, 10);
  }

  private findNearestAccess(): { id: string; distance: number } | null {
    const selected = this.simulation.getOfficers().filter((officer) =>
      this.selectedOfficerIds.has(officer.id) && !officer.isIncapacitated);
    if (selected.length === 0) return null;
    let nearest: { id: string; distance: number } | null = null;
    for (const access of this.simulation.getBuildingSnapshots()) {
      for (const cell of access.cells) {
        const x = cell.column * this.tileSize + this.tileSize / 2;
        const y = cell.row * this.tileSize + this.tileSize / 2;
        for (const officer of selected) {
          const distance = Phaser.Math.Distance.Between(x, y, officer.position.x, officer.position.y);
          if (distance <= 88 && (!nearest || distance < nearest.distance)) nearest = { id: access.id, distance };
        }
      }
    }
    return nearest;
  }

  private interactWithNearestAccess(): void {
    if (this.isPaused) return;
    const selected = this.simulation.getOfficers().filter((officer) =>
      this.selectedOfficerIds.has(officer.id) && !officer.isIncapacitated);
    let nearestCivilian: { id: number; officerId: number; distance: number } | null = null;
    for (const civilian of this.simulation.getCivilians()) {
      if (civilian.state !== 'sheltered') continue;
      for (const officer of selected) {
        const distance = Phaser.Math.Distance.Between(
          civilian.position.x, civilian.position.y, officer.position.x, officer.position.y,
        );
        if (distance <= 80 && (!nearestCivilian || distance < nearestCivilian.distance)) {
          nearestCivilian = { id: civilian.id, officerId: officer.id, distance };
        }
      }
    }
    if (nearestCivilian) {
      this.simulation.rescueCivilian(nearestCivilian.id, nearestCivilian.officerId);
      return;
    }
    const nearest = this.findNearestAccess();
    if (nearest) this.simulation.interactWithAccess(nearest.id, 'police');
  }

  private breachNearestAccess(): void {
    if (this.isPaused) return;
    const nearest = this.findNearestAccess();
    if (nearest) this.simulation.damageAccess(nearest.id, 30);
  }

  private startMaintenance(action: MaintenanceAction): void {
    if (this.isPaused) return;
    const nearest = this.findNearestAccess();
    if (nearest) this.simulation.startBuildingMaintenance(nearest.id, action);
  }

  private updateAccessVisuals(): void {
    this.accessGraphics.clear();
    const colors = { open: 0x55c878, closed: 0xe4c35b, locked: 0xe05b5b,
      barricaded: 0xd88a42, broken: 0x777777 } as const;
    for (const access of this.simulation.getBuildingSnapshots()) {
      this.accessGraphics.fillStyle(colors[access.state], 0.65);
      for (const cell of access.cells) {
        this.accessGraphics.fillRect(cell.column * this.tileSize + 4,
          cell.row * this.tileSize + 4, this.tileSize - 8, this.tileSize - 8);
      }
    }
  }

  private worldToTile(x: number, y: number): TilePosition {
    return {
      column: Math.floor(x / this.tileSize),
      row: Math.floor(y / this.tileSize),
    };
  }

  private spawnDebugInfected(): void {
    const entries = getAvailableEntryPoints(this.worldGrid);
    if (entries.length === 0) return;

    const spawnPlans = [
      { x: 128, y: 640, entryId: 'west-window' },
      { x: 1920, y: 640, entryId: 'east-window' },
      { x: 1024, y: 64, entryId: 'north-window-west' },
      { x: 1024, y: 1216, entryId: 'front-door' },
    ] as const;
    const plan = spawnPlans[this.debugInfectedSpawnIndex % spawnPlans.length]!;
    this.debugInfectedSpawnIndex += 1;
    const entry = entries.find((candidate) => candidate.id === plan.entryId) ?? entries[0]!;
    this.simulation.spawnInfected({
      x: plan.x,
      y: plan.y,
      entryTile: entry.approachTile,
    });
  }

  private updateInfectedVisuals(): void {
    const activeIds = new Set<number>();
    for (const infected of this.simulation.getInfected()) {
      activeIds.add(infected.id);
      let visual = this.infectedVisuals.get(infected.id);
      if (!visual) {
        this.audio.playInfectedGroan();
        const sprite = this.add.sprite(0, 0, 'character-sprites', 12)
          .setOrigin(0.5)
          .setScale(1.2);
        const container = this.add.container(infected.position.x, infected.position.y, [sprite])
          .setDepth(110);
        visual = { id: infected.id, container, sprite };
        this.infectedVisuals.set(infected.id, visual);
      }
      visual.container.setPosition(infected.position.x, infected.position.y);
      if (infected.state === 'dead') {
        this.setCharacterFrame(visual.sprite, 17);
      } else if (infected.state === 'attacking') {
        this.setCharacterFrame(visual.sprite, 15);
      } else if (infected.state === 'moving') {
        this.playCharacterWalk(visual.sprite, 'infected-walk');
      } else {
        this.setCharacterFrame(visual.sprite, 12);
      }
    }

    for (const [id, visual] of this.infectedVisuals) {
      if (activeIds.has(id)) continue;
      visual.container.destroy();
      this.infectedVisuals.delete(id);
    }
  }

  private updateCombatFeedback(): void {
    this.combatGraphics.clear();
    for (const event of this.simulation.getCombatEvents()) {
      if (!this.playedCombatEvents.has(event)) {
        this.playedCombatEvents.add(event);
        this.audio.playGunshot();
      }
      this.combatGraphics.lineStyle(event.hit ? 2 : 1, event.hit ? 0xffd166 : 0x9aa0a6, 0.9);
      this.combatGraphics.beginPath();
      this.combatGraphics.moveTo(event.from.x, event.from.y);
      this.combatGraphics.lineTo(event.to.x, event.to.y);
      this.combatGraphics.strokePath();
      this.combatGraphics.fillStyle(0xffdf70, 0.95);
      this.combatGraphics.fillCircle(event.from.x, event.from.y, 4);
      this.combatGraphics.lineStyle(2, 0xffdf70, 0.9);
      for (const angle of [-0.8, 0, 0.8]) {
        this.combatGraphics.beginPath();
        this.combatGraphics.moveTo(event.from.x + Math.cos(angle) * 5, event.from.y + Math.sin(angle) * 5);
        this.combatGraphics.lineTo(event.from.x + Math.cos(angle) * 10, event.from.y + Math.sin(angle) * 10);
        this.combatGraphics.strokePath();
      }
      if (event.hit) {
        this.combatGraphics.fillStyle(0xffe08a, 0.95);
        this.combatGraphics.fillCircle(event.to.x, event.to.y, 3);
      }
    }
  }

  private updateOfficers(_dt: number): void {
    for (const visual of this.officers) {
      const officer = this.simulation.getOfficers().find((candidate) => candidate.id === visual.id);
      if (!officer) continue;
      const position = officer.position;
      visual.container.setPosition(position.x, position.y);
      visual.container.setRotation(officer.facingAngle + Math.PI / 2);
      visual.container.setAlpha(officer.isIncapacitated ? 0.35 : 1);
      if (officer.isIncapacitated) {
        this.setCharacterFrame(visual.sprite, 5);
      } else if (officer.state === 'attacking') {
        this.setCharacterFrame(visual.sprite, 3);
      } else if (officer.state === 'moving') {
        this.playCharacterWalk(visual.sprite, 'police-walk');
      } else {
        this.setCharacterFrame(visual.sprite, 0);
      }
      visual.selectionRing.setVisible(
        this.selectedOfficerIds.has(officer.id) && !officer.isIncapacitated,
      );
    }
  }

  private updateCamera(dt: number): void {
    if (!this.cameraKeys) return;

    const left = this.cameraKeys.A.isDown || this.cameraKeys.LEFT.isDown;
    const right = this.cameraKeys.D.isDown || this.cameraKeys.RIGHT.isDown;
    const up = this.cameraKeys.W.isDown || this.cameraKeys.UP.isDown;
    const down = this.cameraKeys.S.isDown || this.cameraKeys.DOWN.isDown;
    const horizontal = Number(right) - Number(left);
    const vertical = Number(down) - Number(up);

    if (horizontal === 0 && vertical === 0) return;

    const length = Math.hypot(horizontal, vertical);
    const camera = this.cameras.main;
    const distance = (CAMERA_SPEED * dt) / camera.zoom;
    camera.scrollX += (horizontal / length) * distance;
    camera.scrollY += (vertical / length) * distance;
    this.clampCamera();
  }

  private clampCamera(): void {
    const camera = this.cameras.main;
    const minimumZoom = Math.max(
      MIN_CAMERA_ZOOM,
      camera.width / this.cameraWorldWidth,
      camera.height / this.cameraWorldHeight,
    );
    if (camera.zoom < minimumZoom) camera.setZoom(minimumZoom);
    const maxScrollX = Math.max(0, this.cameraWorldWidth - camera.width / camera.zoom);
    const maxScrollY = Math.max(0, this.cameraWorldHeight - camera.height / camera.zoom);
    camera.setScroll(
      Phaser.Math.Clamp(camera.scrollX, 0, maxScrollX),
      Phaser.Math.Clamp(camera.scrollY, 0, maxScrollY),
    );
  }

  private toggleFullscreen(): void {
    if (this.scale.isFullscreen) this.scale.stopFullscreen();
    else this.scale.startFullscreen();
  }

  private updateMissionResult(): void {
    const status = this.simulation.getState().missionStatus;
    if (status === 'playing') return;
    if (this.resultShown) return;
    this.resultShown = true;
    this.isPaused = true;
    this.simulation.setPaused(true);
    this.pauseMenuOpen = false;
    this.setPauseMenuVisible(false);
    const centerX = this.scale.width / 2;
    const centerY = this.scale.height / 2;
    const victory = status === 'victory';
    if (victory && this.missionId === 0) this.writeStorage(CAMPAIGN_UNLOCK_STORAGE_KEY, '1');
    this.resultPanel.setVisible(true).setPosition(centerX, centerY);
    this.resultText
      .setText(getMissionResultMessage(this.missionId, status))
      .setPosition(centerX, centerY - 48)
      .setVisible(true);
    this.resultHomeButton.setPosition(centerX - 135, centerY + 82).setVisible(true);
    this.resultCampaignButton.setPosition(centerX + 135, centerY + 82)
      .setVisible(victory && this.missionId === 0);
    this.resultRestartButton.setPosition(centerX + 135, centerY + 82)
      .setVisible(!victory || this.missionId === 1);
  }


}
