# Estrutura de pastas

A organização separa interface web, apresentação Phaser, simulação e recursos estáticos. Cada pasta possui uma responsabilidade única.

## Recursos estáticos

```text
public/
├── assets/
│   ├── sprites/                 # Spritesheets de personagens e objetos
│   └── tiles/
│       └── terrain/             # Tilesets de terreno e ambiente
├── audio/
│   ├── music/
│   └── effects/
│       ├── weapons/
│       └── infected/
├── images/                      # Ícones e imagens de marca
└── maps/                        # Mapas exportados do Tiled
```

## Código

```text
src/
├── main.ts                      # Bootstrap e ciclo menu/jogo
├── styles/
│   ├── tokens.css               # Paleta e tokens globais
│   ├── base.css                 # Regras fundamentais
│   ├── menu.css                 # Tela inicial e responsividade
│   ├── dialogs.css              # Diálogos e controles
│   ├── game-shell.css           # Canvas e contêiner do jogo
│   ├── loading.css              # Indicador de inicialização
│   └── index.css                # Composição dos estilos
├── game/
│   ├── audio/
│   ├── presentation/
│   │   └── hudTheme.ts          # Cores semânticas da HUD Phaser
│   ├── scenes/
│   └── config.ts
└── simulation/                  # Regras de domínio sem Phaser/DOM
    ├── entities/
    ├── systems/
    ├── world/
    └── Simulation.ts
```

## Regras de dependência

1. `simulation/` não importa Phaser, DOM, `game/` ou APIs de interface.
2. `game/` pode depender de `simulation/` e Phaser; nunca o inverso.
3. `styles/` contém apenas apresentação web, sem regras de simulação.
4. `game/presentation/` contém tokens visuais usados pelo renderer Phaser.
5. Cenas orquestram sistemas e renderização; regras de domínio ficam fora delas.
6. Dados de cenário, assets e lógica de jogo não devem ser misturados.

## Convenções

- PascalCase para classes e cenas; camelCase para funções e variáveis.
- Sufixos explícitos: `System`, `Manager`, `Renderer`, `Scene` e `Config`.
- Testes unitários ficam junto ao módulo que validam, com o sufixo `.test.ts`.
