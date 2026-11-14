/**
 * Núcleo da simulação do jogo.
 * Não depende de Phaser nem de qualquer API de renderização.
 *
 * Timestep: fixed timestep com acumulador (ADR7).
 */
import { PoliceOfficer, type TacticalPosture } from './entities/PoliceOfficer';
import { Civilian } from './entities/Civilian';
import { Infected } from './entities/Infected';
import type { HumanTarget } from './entities/HumanTarget';
import { CombatSystem, type AmmoStatus, type CombatEvent, type CombatSystemOptions } from './systems/CombatSystem';
import type {
  InfectedConfig,
  InfectedStimulus,
  InfectedStructureTarget,
} from './entities/Infected';
import type { GridMap } from './world/GridMap';
import { BuildingSystem, type AccessSnapshot, type ActorKind } from './systems/buildings/BuildingSystem';
import { BuildingMaintenanceSystem, type MaintenanceAction, type MaintenanceState } from './systems/buildings/BuildingMaintenanceSystem';
import type { TilePosition } from './world/WorldConfig';
import { DeployableStructureSystem, type DeployableKind, type DeployableSnapshot, type DeployableState, type DeployableResources } from './systems/buildings/DeployableStructureSystem';
import { WaveSystem, type WaveDefinition, type WaveSpawnPoint, type WavePhase } from './systems/WaveSystem';

export interface SimulationState {
  elapsed: number;
  paused: boolean;
  officerCount: number;
  activeOfficerCount: number;
  infectedCount: number;
  civilianCount: number;
  rescuedCivilianCount: number;
  missionStatus: 'playing' | 'victory' | 'defeat';
  wavePhase: WavePhase | 'disabled';
  waveNumber: number;
  totalWaves: number;
  preparationRemaining: number;
  remainingToSpawn: number;
}

export const FIXED_DT = 1 / 60;
const MAX_FRAME_DT = 0.25;
const MAX_STEPS_PER_UPDATE = 12;
const WORLD_TILE_SIZE = 32;

function isValidDt(dt: number): boolean {
  return Number.isFinite(dt) && dt >= 0;
}

export class Simulation {
  private elapsed = 0;
  private paused = false;
  private accumulator = 0;
  private readonly officers: PoliceOfficer[] = [
    new PoliceOfficer({ id: 1, x: 57 * WORLD_TILE_SIZE + 16, y: 56 * WORLD_TILE_SIZE + 16 }),
    new PoliceOfficer({ id: 2, x: 60 * WORLD_TILE_SIZE + 16, y: 56 * WORLD_TILE_SIZE + 16 }),
    new PoliceOfficer({ id: 3, x: 63 * WORLD_TILE_SIZE + 16, y: 56 * WORLD_TILE_SIZE + 16 }),
  ];
  private readonly infected: Infected[] = [];
  private additionalHumanTargets: HumanTarget[] = [];
  private readonly civilians: Civilian[] = [
    new Civilian({ id: 1, x: 1856, y: 1456 }),
    new Civilian({ id: 2, x: 2016, y: 1456 }),
  ];
  private readonly combat: CombatSystem;
  private combatEvents: CombatEvent[] = [];
  private nextInfectedId = 1;
  private readonly stimuli: Array<InfectedStimulus & { remaining: number; structure?: InfectedStructureTarget }> = [];
  private nextStimulusId = 1;
  private randomState = 0x6d2b79f5;
  private worldGrid: GridMap | null = null;
  private buildingSystem: BuildingSystem | null = null;
  private maintenanceSystem: BuildingMaintenanceSystem | null = null;
  private deployableSystem: DeployableStructureSystem | null = null;
  private tileSize = WORLD_TILE_SIZE;
  private waveSystem: WaveSystem | null = null;
  private missionStatus: 'playing' | 'victory' | 'defeat' = 'playing';
  private requireCivilianExtraction = true;
  private extractionZone = { x: 1024, y: 1120, radius: 72 };

  constructor(combatOptions: CombatSystemOptions = {}) {
    this.combat = new CombatSystem(combatOptions);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setRandomSeed(seed: number): void {
    if (!Number.isInteger(seed)) throw new RangeError('Random seed must be an integer.');
    this.randomState = (seed >>> 0) || 0x6d2b79f5;
  }

  setWorldGrid(map: GridMap, tileSize: number): void {
    if (!Number.isFinite(tileSize) || tileSize <= 0) {
      throw new RangeError('Tile size must be a positive finite number.');
    }
    this.worldGrid = map;
    this.tileSize = tileSize;
  }

  setBuildingSystem(system: BuildingSystem): void {
    this.buildingSystem = system;
    this.maintenanceSystem = new BuildingMaintenanceSystem(system);
  }

  setDeployableSystem(system: DeployableStructureSystem): void {
    this.deployableSystem = system;
  }

  getDeployableSnapshots(): DeployableSnapshot[] {
    return this.deployableSystem?.getSnapshots() ?? [];
  }

  getDeployableResources(): DeployableResources {
    return this.deployableSystem?.getResources() ?? { scrap: 0, parts: 0 };
  }

  getShelterCapacity(): number {
    return this.deployableSystem?.getShelterCapacity() ?? 0;
  }

  getDeployableState(): DeployableState | null {
    return this.deployableSystem?.exportState() ?? null;
  }

  restoreDeployableState(state: DeployableState): void {
    if (!this.deployableSystem) throw new Error('Deployable structures are not initialized.');
    this.deployableSystem.restoreState(state);
  }

  placeDeployable(kind: DeployableKind, tile: TilePosition): DeployableSnapshot | null {
    if (this.missionStatus !== 'playing' || !this.deployableSystem) return null;
    return this.deployableSystem.place(kind, tile);
  }

  dismantleDeployable(id: number): boolean {
    if (this.missionStatus !== 'playing') return false;
    return this.deployableSystem?.dismantle(id) ?? false;
  }

  getMaintenanceState(): MaintenanceState | null {
    return this.maintenanceSystem?.getState() ?? null;
  }

  restoreMaintenanceState(state: MaintenanceState): void {
    if (!this.maintenanceSystem) throw new Error('Building maintenance is not initialized.');
    this.maintenanceSystem.restoreState(state);
  }

  startBuildingMaintenance(accessId: string, action: MaintenanceAction): boolean {
    return this.maintenanceSystem?.start(accessId, action) ?? false;
  }

  configureWaves(
    spawnPoints: readonly WaveSpawnPoint[],
    waves: readonly WaveDefinition[],
    preparationDuration = 8,
    requireCivilianExtraction = true,
  ): void {
    this.waveSystem = new WaveSystem(spawnPoints, waves, preparationDuration, () => this.nextRandom());
    this.requireCivilianExtraction = requireCivilianExtraction;
    this.missionStatus = 'playing';
  }

  getBuildingSnapshots(): AccessSnapshot[] {
    return this.buildingSystem?.getSnapshots() ?? [];
  }

  interactWithAccess(accessId: string, actor: ActorKind, hasKey = false): boolean {
    const changed = this.buildingSystem?.interact(accessId, actor, hasKey) ?? false;
    if (changed) {
      this.replanOfficerRoutes();
      this.replanCivilianEscorts();
    }
    return changed;
  }

  damageAccess(accessId: string, amount: number): number {
    const before = this.buildingSystem?.getAccess(accessId)?.state;
    const applied = this.buildingSystem?.damage(accessId, amount) ?? 0;
    if (applied > 0 && this.buildingSystem?.getAccess(accessId)?.state !== before) {
      this.replanOfficerRoutes();
      this.replanCivilianEscorts();
    }
    return applied;
  }

  private replanOfficerRoutes(): void {
    if (!this.worldGrid) return;
    const grid = this.buildingSystem?.getNavigationGrid('police') ?? this.worldGrid;
    for (const officer of this.officers) officer.replanMoveOrder(grid, this.tileSize);
  }

  getOfficers(): readonly PoliceOfficer[] {
    return this.officers;
  }

  getInfected(): readonly Infected[] {
    return this.infected;
  }

  getCivilians(): readonly Civilian[] {
    return this.civilians;
  }

  /** Supply additional human roles (survivors, medics, guards, etc.) to infected perception. */
  setAdditionalHumanTargets(targets: readonly HumanTarget[]): void {
    const ids = new Set<number>();
    for (const target of targets) {
      if (!Number.isInteger(target.id) || target.id <= 0 || ids.has(target.id) ||
          !Number.isFinite(target.position.x) || !Number.isFinite(target.position.y) ||
          typeof target.takeDamage !== 'function') {
        throw new RangeError('Additional human targets must have unique ids, finite positions and damage handling.');
      }
      ids.add(target.id);
    }
    this.additionalHumanTargets = [...targets];
  }

  setExtractionZone(zone: { readonly x: number; readonly y: number; readonly radius: number }): void {
    if (![zone.x, zone.y, zone.radius].every(Number.isFinite) || zone.radius <= 0) {
      throw new RangeError('Extraction zone requires finite coordinates and a positive radius.');
    }
    this.extractionZone = { ...zone };
  }

  rescueCivilian(civilianId: number, officerId: number): boolean {
    const civilian = this.civilians.find((candidate) => candidate.id === civilianId);
    const officer = this.officers.find((candidate) => candidate.id === officerId && !candidate.isIncapacitated);
    if (!civilian || !officer) return false;
    if (civilian.state === 'following') return civilian.escortId === officerId;
    if (civilian.state !== 'sheltered') return false;
    if (Math.hypot(civilian.position.x - officer.position.x, civilian.position.y - officer.position.y) > 80) {
      return false;
    }
    return civilian.beginFollowing(officerId);
  }

  private updateCivilianEscorts(dt: number): void {
    if (!this.worldGrid) return;
    const civilGrid = this.buildingSystem?.getNavigationGrid('civil') ?? this.worldGrid;
    for (const civilian of this.civilians) {
      if (civilian.state !== 'following') continue;
      const escort = this.officers.find((officer) => officer.id === civilian.escortId && !officer.isIncapacitated);
      if (!escort) continue;
      const target = {
        x: escort.position.x - Math.cos(escort.facingAngle) * 28,
        y: escort.position.y - Math.sin(escort.facingAngle) * 28,
      };
      civilian.updateFollowing(dt, this.tileSize, civilGrid, target);
      const position = civilian.position;
      if (Math.hypot(position.x - this.extractionZone.x, position.y - this.extractionZone.y) <= this.extractionZone.radius) {
        civilian.extract();
      }
    }
  }

  private updateCivilianAwareness(dt: number, map: GridMap): void {
    const threats = this.infected.filter((infected) => !infected.isDead).map((infected) => infected.position);
    for (const civilian of this.civilians) {
      civilian.updateAwareness(dt, this.tileSize, map, this.officers, threats);
    }
  }

  private replanCivilianEscorts(): void {
    if (!this.worldGrid) return;
    const civilGrid = this.buildingSystem?.getNavigationGrid('civil') ?? this.worldGrid;
    for (const civilian of this.civilians) {
      if (civilian.state !== 'following') continue;
      const escort = this.officers.find((officer) => officer.id === civilian.escortId && !officer.isIncapacitated);
      if (!escort) continue;
      const target = {
        x: escort.position.x - Math.cos(escort.facingAngle) * 28,
        y: escort.position.y - Math.sin(escort.facingAngle) * 28,
      };
      civilian.replan(civilGrid, this.tileSize, target);
    }
  }

  isMissionDefeated(): boolean {
    return this.officers.every((officer) => officer.isIncapacitated) ||
      (this.requireCivilianExtraction && this.civilians.every((civilian) => civilian.isIncapacitated));
  }

  isMissionVictory(): boolean {
    return this.missionStatus === 'victory';
  }

  spawnInfected(config: Omit<InfectedConfig, 'id'>): Infected {
    const infected = new Infected({ ...config, id: this.nextInfectedId++, random: () => this.nextRandom() });
    this.infected.push(infected);
    return infected;
  }

  setTargetPriority(officerId: number, infectedId: number | null): void {
    this.combat.setTargetPriority(officerId, infectedId);
  }

  getCombatEvents(): readonly CombatEvent[] {
    return this.combatEvents;
  }

  getOfficerAmmoStatus(officerId: number): AmmoStatus {
    return this.combat.getAmmoStatus(officerId);
  }

  emitNoiseAtStructure(target: InfectedStructureTarget, radius = 1000, duration = 10): void {
    this.emitStimulus(target.position, radius, 1, duration, target);
  }

  emitStimulus(
    position: { readonly x: number; readonly y: number },
    radius: number,
    strength = 1,
    duration = 5,
    structure?: InfectedStructureTarget,
  ): void {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new RangeError('Stimulus position must be finite.');
    if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('Stimulus radius must be positive.');
    if (!Number.isFinite(strength) || strength <= 0) throw new RangeError('Stimulus strength must be positive.');
    if (!Number.isFinite(duration) || duration <= 0) throw new RangeError('Stimulus duration must be positive.');
    this.stimuli.push({ id: `stimulus-${this.nextStimulusId++}`, position: { ...position }, radius, strength, remaining: duration, ...(structure ? { structure } : {}) });
  }

  private nextRandom(): number {
    let value = this.randomState;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.randomState = value >>> 0;
    return this.randomState / 0x1_0000_0000;
  }

  damageInfected(infectedId: number, amount: number): number {
    const infected = this.infected.find((candidate) => candidate.id === infectedId);
    return infected?.takeDamage(amount) ?? 0;
  }

  issueMoveOrder(officerId: number, destination: TilePosition): boolean {
    const officer = this.officers.find((candidate) => candidate.id === officerId);
    if (!officer || !this.worldGrid || this.isMissionDefeated()) return false;
    const navigationGrid = this.buildingSystem?.getNavigationGrid('police') ?? this.worldGrid;
    return officer.issueMoveOrder(destination, navigationGrid, this.tileSize);
  }

  setOfficerAttacking(officerId: number, attacking: boolean): boolean {
    const officer = this.officers.find((candidate) => candidate.id === officerId);
    return officer ? officer.setAttacking(attacking) : false;
  }

  setOfficerTacticalPosture(officerId: number, posture: TacticalPosture): boolean {
    const officer = this.officers.find((candidate) => candidate.id === officerId);
    return officer ? officer.setTacticalPosture(posture) : false;
  }

  holdOfficerPosition(officerId: number): boolean {
    const officer = this.officers.find((candidate) => candidate.id === officerId);
    return officer ? officer.holdPosition() : false;
  }

  damageOfficer(officerId: number, amount: number): number {
    const officer = this.officers.find((candidate) => candidate.id === officerId);
    const applied = officer?.takeDamage(amount) ?? 0;
    if (this.isMissionDefeated()) this.missionStatus = 'defeat';
    return applied;
  }

  update(dt: number): void {
    this.combatEvents = [];
    if (this.paused || !isValidDt(dt) || this.missionStatus !== 'playing') return;


    this.accumulator += Math.min(dt, MAX_FRAME_DT);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_UPDATE) {
      this.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps += 1;
      if (this.isMissionDefeated()) {
        this.missionStatus = 'defeat';
        this.accumulator = 0;
        break;
      }
      if (this.missionStatus !== 'playing') {
        this.accumulator = 0;
        break;
      }
    }
    if (steps >= MAX_STEPS_PER_UPDATE) this.accumulator = 0;
  }

  private step(dt: number): void {
    this.elapsed += dt;
    const completedMaintenance = this.maintenanceSystem?.update(dt) ?? [];
    if (completedMaintenance.length > 0) {
      this.replanOfficerRoutes();
      this.replanCivilianEscorts();
    }
    for (const officer of this.officers) {
      officer.update(dt, this.tileSize);
    }
    this.updateCivilianEscorts(dt);
    if (this.worldGrid) {
      const baseInfectedGrid = this.buildingSystem?.getNavigationGrid('infected') ?? this.worldGrid;
      const infectedGrid = this.deployableSystem?.getInfectedNavigationGrid(baseInfectedGrid) ?? baseInfectedGrid;
      const policeGrid = this.buildingSystem?.getNavigationGrid('police') ?? this.worldGrid;
      const accessStatesBefore = new Map(
        this.buildingSystem?.getSnapshots().map((access) => [access.id, access.state] as const) ?? [],
      );
      for (let index = this.stimuli.length - 1; index >= 0; index -= 1) {
        this.stimuli[index]!.remaining -= dt;
        if (this.stimuli[index]!.remaining <= 0) this.stimuli.splice(index, 1);
      }
      for (const infected of this.infected) {
        const heardStimuli = this.stimuli.filter((stimulus) =>
          Math.hypot(infected.position.x - stimulus.position.x, infected.position.y - stimulus.position.y) <= stimulus.radius,
        );
        infected.update(dt, this.tileSize, infectedGrid, this.officers, undefined, heardStimuli, this.civilians, this.additionalHumanTargets);
      }
      this.updateCivilianAwareness(dt, this.buildingSystem?.getNavigationGrid('civil') ?? this.worldGrid);
      this.deployableSystem?.update(dt, this.infected);

      const accessChanged = this.buildingSystem?.getSnapshots().some(
        (access) => accessStatesBefore.get(access.id) !== access.state,
      ) ?? false;
      if (accessChanged) {
        this.replanOfficerRoutes();
        this.replanCivilianEscorts();
      }
      const shotEvents = this.combat.update(dt, this.officers, this.infected, policeGrid, this.tileSize);
      this.combatEvents.push(...shotEvents);
      for (const event of shotEvents) {
        this.emitStimulus(event.from, 480, 0.65, 2);
      }
    }
    for (let index = this.infected.length - 1; index >= 0; index -= 1) {
      if (this.infected[index]!.isDead) this.infected.splice(index, 1);
    }
    this.waveSystem?.update(dt, this.infected.length, ({ point, waveNumber }) => {
      this.spawnInfected({
        x: point.x,
        y: point.y,
        entryTile: point.entryTile,
        maxHealth: 60 + (waveNumber - 1) * 10,
        moveSpeed: 55 + (waveNumber - 1) * 3,
        damage: 8 + (waveNumber - 1),
      });
    });
    if (this.waveSystem?.getState().phase === 'completed' && this.infected.length === 0 &&
        (!this.requireCivilianExtraction || this.civilians.every((civilian) => civilian.isRescued))) {
      this.missionStatus = 'victory';
    }
  }

  getState(): SimulationState {
    return {
      elapsed: this.elapsed,
      paused: this.paused,
      officerCount: this.officers.length,
      activeOfficerCount: this.officers.filter((officer) => !officer.isIncapacitated).length,
      infectedCount: this.infected.length,
      civilianCount: this.civilians.length,
      rescuedCivilianCount: this.civilians.filter((civilian) => civilian.isRescued).length,
      missionStatus: this.missionStatus,
      wavePhase: this.waveSystem?.getState().phase ?? 'disabled',
      waveNumber: this.waveSystem?.getState().waveNumber ?? 0,
      totalWaves: this.waveSystem?.getState().totalWaves ?? 0,
      preparationRemaining: this.waveSystem?.getState().preparationRemaining ?? 0,
      remainingToSpawn: this.waveSystem?.getState().remainingToSpawn ?? 0,
    };
  }
}
