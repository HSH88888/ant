// ============================================================
// 🐜 개미 농장 시뮬레이션 - 굴 파기 엔진
// ============================================================
(() => {
    'use strict';

    // ─── Constants ───
    let CELL = 4;
    const SURFACE_RATIO = 0.30;
    const FOOD_SPAWN_INTERVAL = 12000;
    const EGG_HATCH_TIME = 18000;         // 알→유충→번데기→부화
    const EGG_LAY_INTERVAL = 12000;
    const FOOD_PER_EGG = 3;
    const DIG_TIME = 400;
    const MAX_WORKERS = 2000;
    const QUEEN_SPEED = 0.6;
    const WORKER_SPEED = 0.9;
    const GRAVITY = 0.04;

    // ─── Queen Lifecycle Constants ───
    const QUEEN_WING_ENERGY = 30;         // 날개 근육에서 얻는 초기 에너지
    const WING_SHED_DURATION = 2000;      // 날개 떼는 시간 (ms)
    const SEARCH_DURATION = 3000;         // 둥지 후보지 탐색 시간
    const CLAUSTRAL_EGG_COST = 0;         // 밀폐기엔 체내 에너지로 산란
    const CLAUSTRAL_EGG_INTERVAL = 8000;  // 밀폐기 산란 간격
    const SEAL_MARKER = 99;               // 입구 봉쇄 마커 (렌더링용)
    const NANITICS_COUNT = 3;             // 첫 세대 나니틱 수

    // Cell types
    const EMPTY = 0, SOIL = 1, SURFACE = 2, BEDROCK = 3;

    // ─── Utility ───
    const rand = (a, b) => Math.random() * (b - a) + a;
    const randInt = (a, b) => Math.floor(rand(a, b + 1));
    const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

    // ─── Soil Colors (depth-based) ───
    function soilColor(row, totalRows, noiseVal) {
        const depth = row / totalRows;
        const n = noiseVal * 12;
        if (depth < 0.05) {
            // Top soil - dark brown
            return `rgb(${82 + n}, ${62 + n}, ${42 + n})`;
        } else if (depth < 0.3) {
            // Medium soil
            return `rgb(${70 + n}, ${50 + n}, ${32 + n})`;
        } else if (depth < 0.65) {
            // Clay layer - reddish
            return `rgb(${75 + n}, ${45 + n}, ${28 + n})`;
        } else {
            // Deep soil - dark
            return `rgb(${55 + n}, ${38 + n}, ${22 + n})`;
        }
    }

    // Simple deterministic noise per cell
    function cellNoise(col, row) {
        let h = (col * 374761393 + row * 668265263) ^ 1274126177;
        h = ((h >> 16) ^ h) * 0x45d9f3b;
        h = ((h >> 16) ^ h) * 0x45d9f3b;
        h = (h >> 16) ^ h;
        return (h & 0xFF) / 255;
    }

    // ─── Grid ───
    class Grid {
        constructor(cols, rows, surfaceRow) {
            this.cols = cols;
            this.rows = rows;
            this.surfaceRow = surfaceRow;
            this.cells = new Uint8Array(cols * rows);
            this.noise = new Float32Array(cols * rows);
            this.dirtyCells = [];
            this._init();
        }
        _init() {
            for (let r = 0; r < this.rows; r++) {
                for (let c = 0; c < this.cols; c++) {
                    const i = r * this.cols + c;
                    this.noise[i] = cellNoise(c, r);
                    if (r < this.surfaceRow) {
                        this.cells[i] = EMPTY; // sky
                    } else if (r === this.surfaceRow) {
                        this.cells[i] = SURFACE;
                    } else if (r >= this.rows - 2) {
                        this.cells[i] = BEDROCK;
                    } else {
                        this.cells[i] = SOIL;
                    }
                }
            }
            // Add some rocks/pebbles (random bedrock patches)
            for (let i = 0; i < Math.floor(this.cols * this.rows * 0.005); i++) {
                const c = randInt(0, this.cols - 1);
                const r = randInt(this.surfaceRow + 10, this.rows - 4);
                if (this.get(c, r) === SOIL) {
                    this.set(c, r, BEDROCK);
                }
            }
        }
        idx(c, r) { return r * this.cols + c; }
        get(c, r) {
            if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return BEDROCK;
            return this.cells[this.idx(c, r)];
        }
        set(c, r, v) {
            if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return;
            const idx = this.idx(c, r);
            if (this.cells[idx] !== v) {
                this.cells[idx] = v;
                this.dirtyCells.push({c, r});
            }
        }
        isWalkable(c, r) {
            const v = this.get(c, r);
            return v === EMPTY || v === SURFACE;
        }
        isDiggable(c, r) {
            return this.get(c, r) === SOIL;
        }
        // Count empty neighbors (for room detection)
        emptyNeighbors(c, r) {
            let count = 0;
            for (let dr = -1; dr <= 1; dr++)
                for (let dc = -1; dc <= 1; dc++)
                    if ((dr || dc) && this.isWalkable(c + dc, r + dr)) count++;
            return count;
        }
        // Check if ant has ground support (can stand)
        hasSupport(c, r) {
            // On surface row or has solid below or solid to side (clinging to wall)
            if (r >= this.rows - 1) return true;
            const below = this.get(c, r + 1);
            if (below === SOIL || below === BEDROCK || below === SURFACE) return true;
            // Wall clinging - solid on left or right
            const left = this.get(c - 1, r);
            const right = this.get(c + 1, r);
            if (left === SOIL || left === BEDROCK) return true;
            if (right === SOIL || right === BEDROCK) return true;
            // Diagonal support
            const bl = this.get(c - 1, r + 1);
            const br = this.get(c + 1, r + 1);
            if (bl === SOIL || bl === BEDROCK) return true;
            if (br === SOIL || br === BEDROCK) return true;
            return false;
        }
        countEmpty() {
            let count = 0;
            for (let r = this.surfaceRow + 1; r < this.rows - 2; r++)
                for (let c = 0; c < this.cols; c++)
                    if (this.cells[this.idx(c, r)] === EMPTY) count++;
            return count;
        }
    }

    // ─── Food on Surface ───
    class FoodItem {
        constructor(x, y, amount) {
            this.x = x;
            this.y = y;
            this.amount = amount || randInt(3, 8);
            this.phase = Math.random() * 6.28;
        }
        get depleted() { return this.amount <= 0; }
    }

    // ─── Egg (알 → 유충 → 번데기 → 부화) ───
    class Egg {
        constructor(col, row, isNanitic = false) {
            this.col = col;
            this.row = row;
            this.timer = EGG_HATCH_TIME;
            this.hatched = false;
            this.isNanitic = isNanitic; // 첫 세대 나니틱 여부
        }
        update(dt) {
            this.timer -= dt;
            if (this.timer <= 0) this.hatched = true;
        }
        get progress() { return 1 - this.timer / EGG_HATCH_TIME; }
        // 단계: 0~0.33 알, 0.33~0.66 유충, 0.66~1.0 번데기
        get stage() {
            const p = this.progress;
            if (p < 0.33) return 'egg';
            if (p < 0.66) return 'larva';
            return 'pupa';
        }
    }

    // ─── Base Ant ───
    class Ant {
        constructor(col, row) {
            this.col = col;
            this.row = row;
            this.x = col * CELL + CELL / 2;
            this.y = row * CELL + CELL / 2;
            this.targetCol = col;
            this.targetRow = row;
            this.moving = false;
            this.digTimer = 0;
            this.digging = false;
            this.facingRight = Math.random() > 0.5;
            this.walkFrame = 0;
            this.fallSpeed = 0;
        }

        moveTo(tc, tr, grid) {
            if (this.moving || this.digging) return false;
            if (tc < 0 || tc >= grid.cols || tr < 0 || tr >= grid.rows) return false;

            if (grid.isWalkable(tc, tr)) {
                this.targetCol = tc;
                this.targetRow = tr;
                this.moving = true;
                this.facingRight = tc > this.col;
                return true;
            } else if (grid.isDiggable(tc, tr)) {
                this.targetCol = tc;
                this.targetRow = tr;
                this.digging = true;
                this.digTimer = DIG_TIME;
                this.facingRight = tc > this.col;
                return true;
            }
            return false;
        }

        update(dt, grid) {
            // Digging
            if (this.digging) {
                this.digTimer -= dt;
                if (this.digTimer <= 0) {
                    grid.set(this.targetCol, this.targetRow, EMPTY);
                    this.col = this.targetCol;
                    this.row = this.targetRow;
                    this.x = this.col * CELL + CELL / 2;
                    this.y = this.row * CELL + CELL / 2;
                    this.digging = false;
                }
                return;
            }

            // Moving
            if (this.moving) {
                const tx = this.targetCol * CELL + CELL / 2;
                const ty = this.targetRow * CELL + CELL / 2;
                const dx = tx - this.x;
                const dy = ty - this.y;
                const d = Math.hypot(dx, dy);
                const spd = this.speed * (dt / 16) * CELL * 0.15;
                if (d < spd) {
                    this.x = tx;
                    this.y = ty;
                    this.col = this.targetCol;
                    this.row = this.targetRow;
                    this.moving = false;
                } else {
                    this.x += (dx / d) * spd;
                    this.y += (dy / d) * spd;
                }
                this.walkFrame += dt * 0.008;
                return;
            }

            // Gravity - fall if no support
            if (!grid.hasSupport(this.col, this.row) && grid.isWalkable(this.col, this.row + 1)) {
                this.row++;
                this.targetRow = this.row;
                this.y = this.row * CELL + CELL / 2;
            }
        }
    }

    // ─── Queen Ant AI (실제 여왕개미 일생 기반) ───
    // 혼인비행 후 착지 → 날개 떼기(탈시) → 둥지 후보지 탐색 →
    // 수직 갱도 굴착 → 산란실 조성 → 입구 봉쇄(밀폐 창립) →
    // 체내 에너지로 산란·육아 → 나니틱 부화 → 콜로니 성장기
    const Q_STATE = {
        LANDING: 0,      // 혼인비행 후 지면 착지
        WING_SHED: 1,    // 날개 떼기 (탈시) - 날개 근육을 영양분으로 전환
        SEARCH_SITE: 2,  // 둥지 후보지 탐색 - 지표면 이동
        DIG_SHAFT: 3,    // 수직 갱도 굴착
        DIG_CHAMBER: 4,  // 산란실(여왕방) 조성
        CLAUSTRAL: 5,    // 밀폐 창립기: 입구 봉쇄, 체내 에너지로 산란·육아
        MATURE: 6        // 성숙기: 일개미가 먹이 조달, 여왕은 산란 전담
    };

    class QueenAnt extends Ant {
        constructor(col, row) {
            super(col, row);
            this.speed = QUEEN_SPEED;
            this.state = Q_STATE.LANDING;

            // ── 생체 에너지 시스템 ──
            this.hasWings = true;              // 날개 유무
            this.wingEnergy = QUEEN_WING_ENERGY; // 날개 근육 → 영양분
            this.wingShedTimer = 0;            // 탈시 타이머

            // ── 둥지 탐색 ──
            this.searchTimer = SEARCH_DURATION;
            this.searchDir = Math.random() > 0.5 ? 1 : -1;

            // ── 갱도/산란실 ──
            this.shaftDepth = 0;
            this.targetShaftDepth = randInt(12, 20);
            this.chamberWidth = 0;
            this.chamberTarget = randInt(5, 8);
            this.chamberDir = 1;
            this.entryCol = col;               // 입구 위치 기억
            this.entryRow = 0;                 // 입구 행
            this.sealCol = -1;                 // 봉쇄 지점
            this.sealRow = -1;

            // ── 산란 ──
            this.eggTimer = CLAUSTRAL_EGG_INTERVAL * 0.3;
            this.naniticsLaid = 0;             // 밀폐기 동안 낳은 알 수
            this.naniticsHatched = 0;          // 부화한 나니틱 수
            this.broodCareTimer = 0;           // 알 돌봄 타이머

            // ── 공통 ──
            this.waitTimer = 800;
            this.nestCol = col;
            this.nestRow = row;
            this.colonyPhase = '착지';         // HUD 표시용
        }

        think(dt, grid, colony) {
            if (this.moving || this.digging) return;

            switch (this.state) {
                case Q_STATE.LANDING: this._doLanding(dt, grid, colony); break;
                case Q_STATE.WING_SHED: this._doWingShed(dt, grid, colony); break;
                case Q_STATE.SEARCH_SITE: this._doSearchSite(dt, grid, colony); break;
                case Q_STATE.DIG_SHAFT: this._doDigShaft(dt, grid, colony); break;
                case Q_STATE.DIG_CHAMBER: this._doDigChamber(dt, grid, colony); break;
                case Q_STATE.CLAUSTRAL: this._doClaustral(dt, grid, colony); break;
                case Q_STATE.MATURE: this._doMature(dt, grid, colony); break;
            }
        }

        // ── Stage 1: 착지 ──
        _doLanding(dt, grid, colony) {
            this.waitTimer -= dt;
            if (this.waitTimer <= 0) {
                colony.showEvent('👑 여왕개미가 혼인비행 후 착지했습니다');
                this.colonyPhase = '탈시(날개 떼기)';
                this.state = Q_STATE.WING_SHED;
                this.wingShedTimer = WING_SHED_DURATION;
            }
        }

        // ── Stage 2: 날개 떼기 (탈시) ──
        _doWingShed(dt, grid, colony) {
            this.wingShedTimer -= dt;
            if (this.wingShedTimer <= 0) {
                this.hasWings = false;
                // 날개 근육을 체내 에너지로 전환
                this.wingEnergy = QUEEN_WING_ENERGY;
                colony.showEvent('✂️ 여왕이 날개를 떼어냈습니다 (에너지 비축)');
                this.colonyPhase = '둥지 탐색';
                this.state = Q_STATE.SEARCH_SITE;
                this.searchTimer = SEARCH_DURATION;
            }
        }

        // ── Stage 3: 둥지 후보지 탐색 ──
        _doSearchSite(dt, grid, colony) {
            this.searchTimer -= dt;
            // 지표면을 돌아다니며 적절한 장소 물색
            const dc = this.searchDir;
            if (grid.isWalkable(this.col + dc, this.row)) {
                this.moveTo(this.col + dc, this.row, grid);
            } else {
                this.searchDir *= -1;
            }
            if (this.searchTimer <= 0) {
                this.entryCol = this.col;
                this.entryRow = this.row;
                colony.showEvent('📍 여왕이 둥지 후보지를 선정했습니다');
                this.colonyPhase = '갱도 굴착';
                this.state = Q_STATE.DIG_SHAFT;
            }
        }

        // ── Stage 4: 수직 갱도 굴착 ──
        _doDigShaft(dt, grid, colony) {
            if (this.shaftDepth >= this.targetShaftDepth) {
                this.nestRow = this.row;
                this.nestCol = this.col;
                colony.showEvent('⛏️ 수직 갱도 완성! 산란실 조성 시작');
                this.colonyPhase = '산란실 조성';
                this.state = Q_STATE.DIG_CHAMBER;
                return;
            }
            if (this.moveTo(this.col, this.row + 1, grid)) {
                this.shaftDepth++;
            } else {
                const side = Math.random() > 0.5 ? 1 : -1;
                this.moveTo(this.col + side, this.row, grid);
            }
        }

        // ── Stage 5: 산란실 조성 ──
        _doDigChamber(dt, grid, colony) {
            if (this.chamberWidth >= this.chamberTarget) {
                this.nestCol = this.col;
                this.nestRow = this.row;
                // 입구 봉쇄
                this._sealEntrance(grid);
                colony.showEvent('🔒 여왕이 입구를 봉쇄했습니다 (밀폐 창립)');
                this.colonyPhase = '밀폐 창립기';
                this.state = Q_STATE.CLAUSTRAL;
                return;
            }
            const nextCol = this.col + this.chamberDir;
            if (nextCol <= 1 || nextCol >= grid.cols - 2) {
                this.chamberDir *= -1;
            }
            if (this.moveTo(this.col + this.chamberDir, this.row, grid)) {
                this.chamberWidth++;
                // 방 높이를 위해 위쪽도 파기
                if (grid.isDiggable(this.col, this.row - 1)) {
                    grid.set(this.col, this.row - 1, EMPTY);
                }
            } else {
                this.chamberDir *= -1;
            }
        }

        // 입구 봉쇄 (밀폐 창립의 핵심)
        _sealEntrance(grid) {
            // 갱도 입구 근처 첫 빈 셀을 봉쇄 표시
            for (let r = grid.surfaceRow + 1; r < grid.surfaceRow + 4; r++) {
                if (grid.get(this.entryCol, r) === EMPTY) {
                    this.sealCol = this.entryCol;
                    this.sealRow = r;
                    return;
                }
            }
        }

        // ── Stage 6: 밀폐 창립기 (Claustral Founding) ──
        // 외부와 차단. 날개 근육 에너지로 산란·육아.
        // 먹이를 먹지 않고 체내 비축분만으로 버틴다.
        _doClaustral(dt, grid, colony) {
            // 체내 에너지 소모
            this.wingEnergy -= dt * 0.0003;

            // 알 돌봄 행동 (항균 타액으로 알 닦기, 위치 조정)
            this.broodCareTimer -= dt;
            if (this.broodCareTimer <= 0 && colony.eggs.length > 0) {
                // 알 근처로 이동 (돌봄 시뮬레이션)
                const egg = colony.eggs[0];
                if (Math.abs(this.col - egg.col) > 1) {
                    const dc = egg.col > this.col ? 1 : -1;
                    if (grid.isWalkable(this.col + dc, this.row)) {
                        this.moveTo(this.col + dc, this.row, grid);
                    }
                }
                this.broodCareTimer = rand(2000, 4000);
            }

            // 밀폐기 산란 (체내 에너지 사용, 외부 먹이 불필요)
            this.eggTimer -= dt;
            if (this.eggTimer <= 0 && this.wingEnergy > 3 && this.naniticsLaid < NANITICS_COUNT) {
                this.wingEnergy -= 3;
                colony.eggs.push(new Egg(this.col, this.row, true)); // 나니틱
                this.naniticsLaid++;
                colony.showEvent(`🥚 밀폐기 산란 (${this.naniticsLaid}/${NANITICS_COUNT}) - 체내 에너지 사용`);
                this.eggTimer = CLAUSTRAL_EGG_INTERVAL;
            } else if (this.eggTimer <= 0) {
                this.eggTimer = 3000;
            }

            // 나니틱 부화 확인 → 성숙기 전환
            if (this.naniticsHatched >= NANITICS_COUNT) {
                // 입구 개봉 (나니틱이 봉쇄를 열음)
                if (this.sealCol >= 0) {
                    grid.set(this.sealCol, this.sealRow, EMPTY);
                }
                colony.showEvent('🎉 나니틱(첫 일개미)이 입구를 열었습니다! 콜로니 성장 시작');
                this.colonyPhase = '콜로니 성장기';
                this.state = Q_STATE.MATURE;
            }

            // 산란실 내 약간의 이동
            this.waitTimer -= dt;
            if (this.waitTimer <= 0 && !this.moving) {
                const dc = randInt(-1, 1);
                if (grid.isWalkable(this.col + dc, this.row)) {
                    this.moveTo(this.col + dc, this.row, grid);
                }
                this.waitTimer = rand(2000, 5000);
            }
        }

        // ── Stage 7: 성숙기 (일개미가 먹이 조달, 여왕은 산란 전담) ──
        _doMature(dt, grid, colony) {
            this.eggTimer -= dt;
            if (this.eggTimer <= 0 && colony.food >= FOOD_PER_EGG && colony.workerCount + colony.eggs.length < MAX_WORKERS) {
                colony.food -= FOOD_PER_EGG;
                colony.eggs.push(new Egg(this.col, this.row, false));
                colony.showEvent('🥚 여왕이 알을 낳았습니다');
                this.eggTimer = EGG_LAY_INTERVAL;
            } else if (this.eggTimer <= 0) {
                this.eggTimer = 4000;
            }

            // 산란실 내 천천히 이동
            this.waitTimer -= dt;
            if (this.waitTimer <= 0) {
                const dc = randInt(-1, 1);
                if (grid.isWalkable(this.col + dc, this.row)) {
                    this.moveTo(this.col + dc, this.row, grid);
                }
                this.waitTimer = rand(1500, 4000);
            }
        }
    }

    // ─── BFS 경로 탐색기 (터널 내비게이션) ───
    function bfsNextStep(startCol, startRow, targetCol, targetRow, grid, maxSteps = 800) {
        if (startCol === targetCol && startRow === targetRow) return null;
        const key = (c, r) => r * grid.cols + c;
        const visited = new Set();
        visited.add(key(startCol, startRow));
        const queue = [];
        const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
        for (const [dc, dr] of dirs) {
            const nc = startCol + dc, nr = startRow + dr;
            if (!grid.isWalkable(nc, nr)) continue;
            const k = key(nc, nr);
            if (visited.has(k)) continue;
            visited.add(k);
            queue.push({ col: nc, row: nr, dc, dr });
        }
        let steps = 0, head = 0;
        while (head < queue.length && steps < maxSteps) {
            const cur = queue[head++]; steps++;
            if (Math.abs(cur.col - targetCol) <= 1 && Math.abs(cur.row - targetRow) <= 1)
                return { dc: cur.dc, dr: cur.dr };
            for (const [ddc, ddr] of dirs) {
                const nc = cur.col + ddc, nr = cur.row + ddr;
                if (!grid.isWalkable(nc, nr)) continue;
                const k = key(nc, nr);
                if (visited.has(k)) continue;
                visited.add(k);
                queue.push({ col: nc, row: nr, dc: cur.dc, dr: cur.dr });
            }
        }
        return null;
    }

    // ─── 일개미 AI (카스트 기반) ───
    const W_STATE = {
        IDLE: 0,
        FORAGE_TO_SURFACE: 1,
        FORAGE_SEARCH: 2,
        FORAGE_RETURN: 3,
        DIG_EXPLORE: 4,
        DIG_FOOD_CHAMBER: 5,
        NURSE_CARE: 6,
        NURSE_FEED: 7,
        GUARD_PATROL: 8,
        GUARD_EGGS: 9,
        MALE_ASCEND: 10,
        WANDER: 11,
        DIG_NURSERY: 12,
        DIG_RESTING: 13,
        NURSE_TRANSPORT: 14,
        TIRED_RETURN: 15,
        SLEEPING: 16,
        DIG_ACTION: 17
    };

    // 5가지 카스트 (부화 시 고정)
    const CASTE = {
        FORAGER: 'forager',   // 채집: 먹이 수집·운반
        DIGGER: 'digger',     // 굴착: 터널·방 확장
        NURSE: 'nurse',       // 육아: 알/유충 돌봄
        GUARD: 'guard',       // 경비: 입구 순찰, 알 방어
        MALE: 'male',         // 숫개미: 혼인비행 준비
    };

    // 카스트 배분 비율 (성장기)
    function assignCaste(colony) {
        const r = Math.random();
        // 성숙기에 일정 확률로 숫개미 생성
        if (game.queen && game.queen.state === Q_STATE.MATURE && game.workers.length > 8 && r < 0.08)
            return CASTE.MALE;
        if (r < 0.30) return CASTE.FORAGER;
        if (r < 0.55) return CASTE.DIGGER;
        if (r < 0.75) return CASTE.NURSE;
        return CASTE.GUARD;
    }

    class WorkerAnt extends Ant {
        constructor(col, row, caste = CASTE.FORAGER) {
            super(col, row);
            this.speed = WORKER_SPEED;
            this.state = W_STATE.IDLE;
            this.caste = caste;           // 고정 카스트
            this.energy = 100;            // 에너지 (0-100)
            this.maxEnergy = 100;
            this.isNanitic = false;
            this.hasWings = caste === CASTE.MALE; // 숫개미는 날개 있음

            this.carryingFood = false;
            this.waitTimer = rand(500, 2000);
            this.digDirection = 0;
            this.digCount = 0;
            this.maxDigCount = randInt(5, 15);
            this.stuckCount = 0;
            this.prevCol = col;
            this.prevRow = row;
            this.patrolDir = Math.random() > 0.5 ? 1 : -1; // 경비 순찰 방향

            // BFS 경로 캐시
            this._pathTarget = null;
            this._pathStep = null;
            this._pathAge = 0;
        }

        think(dt, grid, colony, foods, queen) {
            if (this.moving || this.digging) return;

            // 스턱 감지 (강화)
            if (this.col === this.prevCol && this.row === this.prevRow) {
                this.stuckCount++;
                if (this.stuckCount > 8) {
                    // BFS 캐시 무효화 + 랜덤 이동
                    this._pathStep = null;
                    this._pathTarget = null;
                    this._pathAge = 999;
                    // 주변에 파낼 수 있는 흙이 있으면 파서 탈출
                    const escapeDirs = [[0, -1], [1, 0], [-1, 0], [0, 1]];
                    let escaped = false;
                    for (const [dc, dr] of escapeDirs) {
                        const nc = this.col + dc, nr = this.row + dr;
                        if (grid.isDiggable(nc, nr)) {
                            this.moveTo(nc, nr, grid);
                            escaped = true;
                            break;
                        }
                    }
                    if (!escaped) this._pickRandomWalkable(grid);
                    this.stuckCount = 0;
                    // 너무 오래 고정되면 IDLE로
                    if (this.state === W_STATE.FORAGE_TO_SURFACE || this.state === W_STATE.GUARD_PATROL) {
                        this._stuckTotal = (this._stuckTotal || 0) + 1;
                        if (this._stuckTotal > 5) {
                            this.state = W_STATE.WANDER;
                            this.waitTimer = rand(2000, 5000);
                            this._stuckTotal = 0;
                        }
                    }
                }
            } else {
                this.stuckCount = 0;
                this._stuckTotal = 0;
            }
            this.prevCol = this.col;
            this.prevRow = this.row;
            this._pathAge++;

            switch (this.state) {
                case W_STATE.IDLE: this._doIdle(dt, grid, colony, queen); break;
                case W_STATE.FORAGE_TO_SURFACE: this._doForageToSurface(dt, grid, queen); break;
                case W_STATE.FORAGE_SEARCH: this._doForageSearch(dt, grid, foods); break;
                case W_STATE.FORAGE_RETURN: this._doForageReturn(dt, grid, colony, queen); break;
                case W_STATE.DIG_EXPLORE: this._doDigExplore(dt, grid, colony); break;
                case W_STATE.DIG_FOOD_CHAMBER: this._doDigFoodChamber(dt, grid, colony, queen); break;
                case W_STATE.NURSE_CARE: this._doNurseCare(dt, grid, colony); break;
                case W_STATE.NURSE_FEED: this._doNurseFeed(dt, grid, colony); break;
                case W_STATE.GUARD_PATROL: this._doGuardPatrol(dt, grid, queen); break;
                case W_STATE.GUARD_EGGS: this._doGuardEggs(dt, grid, colony); break;
                case W_STATE.MALE_ASCEND: this._doMaleAscend(dt, grid, queen); break;
                case W_STATE.WANDER: this._doWander(dt, grid); break;
                case W_STATE.DIG_NURSERY: this._doDigNursery(dt, grid, colony, queen); break;
                case W_STATE.DIG_RESTING: this._doDigResting(dt, grid, colony, queen); break;
                case W_STATE.NURSE_TRANSPORT: this._doNurseTransport(dt, grid, colony); break;
                case W_STATE.TIRED_RETURN: this._doTiredReturn(dt, grid, colony); break;
                case W_STATE.SLEEPING: this._doSleep(dt); break;
                case W_STATE.DIG_ACTION: this._doDigAction(dt, grid, colony); break;
            }
        }

        // ── IDLE: 카스트에 따른 행동 결정 ──
        _doIdle(dt, grid, colony, queen) {
            this.waitTimer -= dt;
            if (this.waitTimer <= 0) {
                this._pathStep = null;

                // 0. 피로도 체크: 에너지 20% 미만이면 휴식 (여왕 제외)
                if (this.energy < 20) {
                    this.state = W_STATE.TIRED_RETURN;
                    return;
                }

                switch (this.caste) {
                    case CASTE.FORAGER:
                        this.state = W_STATE.FORAGE_TO_SURFACE;
                        break;
                    case CASTE.DIGGER:
                        // 우선순위: Food -> Resting (Nursery는 Nurse가 담당)
                        if (!colony.foodChamber && queen.state >= Q_STATE.MATURE) {
                            this.state = W_STATE.DIG_FOOD_CHAMBER;
                        } else if (!colony.restingChamber && colony.nurseryChamber) {
                            this.state = W_STATE.DIG_RESTING;
                        } else {
                            this.state = W_STATE.DIG_EXPLORE;
                            this.digCount = 0;
                            this.maxDigCount = randInt(5, 15);
                            this.digDirection = Math.random() > 0.5 ? 1 : -1;
                        }
                        break;
                    case CASTE.NURSE:
                        // 0. 보육방 건설 (식량이 확보되면)
                        if (!colony.nurseryChamber && colony.foodChamber) {
                            this.state = W_STATE.DIG_NURSERY;
                            break;
                        }

                        // 1. 알이 보육방 밖에 있으면 운반
                        const unsafeEgg = colony.eggs.find(e =>
                            colony.nurseryChamber && (Math.abs(e.col - colony.nurseryChamber.col) > 4 || Math.abs(e.row - colony.nurseryChamber.row) > 4)
                        );
                        if (unsafeEgg && colony.nurseryChamber) {
                            this.state = W_STATE.NURSE_TRANSPORT;
                        } else if (colony.eggs.length > 0) {
                            this.state = W_STATE.NURSE_CARE;
                        } else {
                            this.state = W_STATE.WANDER;
                        }
                        break;
                    case CASTE.GUARD:
                        if (colony.eggs.length > 0 && Math.random() < 0.4) {
                            this.state = W_STATE.GUARD_EGGS;
                        } else {
                            this.state = W_STATE.GUARD_PATROL;
                        }
                        break;
                    case CASTE.MALE:
                        this.state = W_STATE.MALE_ASCEND;
                        break;
                    default:
                        this.state = W_STATE.WANDER;
                        break;
                }

                // 상태가 여전히 IDLE이면 대기
                if (this.state === W_STATE.IDLE) {
                    this.waitTimer = rand(500, 1500);
                }
            }
        }

        // ── 채집: BFS로 지표면까지 이동 ──
        _doForageToSurface(dt, grid, queen) {
            // 이미 지표면 도달
            if (this.row <= grid.surfaceRow) {
                this.state = W_STATE.FORAGE_SEARCH;
                return;
            }

            // BFS로 입구(여왕의 entryCol, surfaceRow) 방향 탐색
            const targetCol = queen.entryCol;
            const targetRow = grid.surfaceRow;

            const step = this._getBfsStep(targetCol, targetRow, grid);
            if (step) {
                this.moveTo(this.col + step.dc, this.row + step.dr, grid);
            } else {
                // BFS 실패 → 입구 방향으로 파며 올라감
                const dc = targetCol > this.col ? 1 : targetCol < this.col ? -1 : 0;
                // 우선순위: 1)위로 걸어감 2)입구 쪽 가로 이동 3)위로 파기 4)가로 파기
                if (grid.isWalkable(this.col, this.row - 1)) {
                    this.moveTo(this.col, this.row - 1, grid);
                } else if (dc !== 0 && grid.isWalkable(this.col + dc, this.row)) {
                    this.moveTo(this.col + dc, this.row, grid);
                } else if (grid.isDiggable(this.col, this.row - 1)) {
                    this.moveTo(this.col, this.row - 1, grid);
                } else if (dc !== 0 && grid.isDiggable(this.col + dc, this.row)) {
                    this.moveTo(this.col + dc, this.row, grid);
                } else {
                    this._pickRandomWalkable(grid);
                }
            }
        }

        // ── 채집: 지표면에서 먹이 탐색 ──
        _doForageSearch(dt, grid, foods) {
            // 지하로 떨어졌으면 다시 올라가기
            if (this.row > grid.surfaceRow + 1) {
                this.state = W_STATE.FORAGE_TO_SURFACE;
                return;
            }

            let closestFood = null;
            let closestDist = Infinity;
            for (const f of foods) {
                if (f.depleted) continue;
                const d = Math.abs(f.x / CELL - this.col);
                if (d < closestDist) { closestDist = d; closestFood = f; }
            }

            if (closestFood && closestDist < 3) {
                closestFood.amount--;
                this.carryingFood = true;
                this.state = W_STATE.FORAGE_RETURN;
                this._pathStep = null;
                return;
            }

            // 먹이 쪽으로 이동
            if (closestFood) {
                const foodCol = Math.floor(closestFood.x / CELL);
                const dc = foodCol > this.col ? 1 : -1;
                this.moveTo(this.col + dc, this.row, grid);
            } else {
                const dc = Math.random() > 0.5 ? 1 : -1;
                this.moveTo(this.col + dc, this.row, grid);
            }

            // 오래 못 찾으면 돌아감
            this.waitTimer -= dt;
            if (this.waitTimer <= -8000) {
                this.state = W_STATE.IDLE;
                this.waitTimer = 2000;
            }
        }

        // ── 채집: 먹이를 먹이 창고(또는 여왕방)로 운반 ──
        // 2단계: 1) 지표면이면 입구로 이동  2) 지하면 BFS로 목표로
        _doForageReturn(dt, grid, colony, queen) {
            const nestCol = colony.foodChamber ? colony.foodChamber.col : queen.nestCol;
            const nestRow = colony.foodChamber ? colony.foodChamber.row : queen.nestRow;

            // 도착 확인
            if (Math.abs(this.row - nestRow) < 3 && Math.abs(this.col - nestCol) < 5) {
                colony.food += 2;
                this.carryingFood = false;
                colony.deliveries++;
                if (colony.foodChamber) {
                    colony.storedFoodItems.push({
                        col: this.col + randInt(-2, 2),
                        row: this.row + randInt(-1, 0),
                        size: rand(0.3, 0.8)
                    });
                    if (colony.storedFoodItems.length > 20)
                        colony.storedFoodItems.shift();
                }
                this.state = W_STATE.IDLE;
                this.waitTimer = rand(800, 1500);
                colony.showEvent('🍎 채집개미가 먹이 창고에 식량을 저장했습니다');
                return;
            }

            const entryCol = queen.entryCol;
            const entryRow = grid.surfaceRow;

            // === 1단계: 지표면에 있으면 입구로 직접 이동 ===
            if (this.row <= entryRow) {
                // 입구 근처 도달
                if (Math.abs(this.col - entryCol) <= 1) {
                    // 입구 아래로 들어가기
                    if (grid.isWalkable(entryCol, entryRow + 1)) {
                        this.moveTo(entryCol, entryRow + 1, grid);
                    } else if (grid.isWalkable(this.col, this.row + 1)) {
                        this.moveTo(this.col, this.row + 1, grid);
                    } else {
                        // 입구가 막혔으면 파기
                        if (grid.isDiggable(entryCol, entryRow + 1)) {
                            this.moveTo(entryCol, entryRow + 1, grid);
                        }
                    }
                    return;
                }
                // 입구 쪽으로 걸어가기 (단순 가로 이동)
                const dc = entryCol > this.col ? 1 : -1;
                if (grid.isWalkable(this.col + dc, this.row)) {
                    this.moveTo(this.col + dc, this.row, grid);
                } else {
                    this._pickRandomWalkable(grid);
                }
                return;
            }

            // === 2단계: 지하에서 BFS로 목표로 ===
            const step = this._getBfsStep(nestCol, nestRow, grid);
            if (step) {
                this.moveTo(this.col + step.dc, this.row + step.dr, grid);
            } else {
                // BFS 실패 → 목표 방향으로 직접 + 굴착
                const dc = nestCol > this.col ? 1 : nestCol < this.col ? -1 : 0;
                const dr = nestRow > this.row ? 1 : nestRow < this.row ? -1 : 0;
                if (dr !== 0 && grid.isWalkable(this.col, this.row + dr)) {
                    this.moveTo(this.col, this.row + dr, grid);
                } else if (dc !== 0 && grid.isWalkable(this.col + dc, this.row)) {
                    this.moveTo(this.col + dc, this.row, grid);
                } else if (dr !== 0 && grid.isDiggable(this.col, this.row + dr)) {
                    this.moveTo(this.col, this.row + dr, grid);
                } else if (dc !== 0 && grid.isDiggable(this.col + dc, this.row)) {
                    this.moveTo(this.col + dc, this.row, grid);
                } else {
                    this._pickRandomWalkable(grid);
                }
            }
        }

        // ── 굴착: 새 터널 탐험 ──
        _doDigExplore(dt, grid, colony) {
            if (this.digCount >= this.maxDigCount) {
                this.state = W_STATE.IDLE;
                this.waitTimer = rand(1000, 3000);
                return;
            }

            const directions = this._getDigPriorities(grid);
            for (const [dc, dr] of directions) {
                const nc = this.col + dc;
                const nr = this.row + dr;
                if (nr < grid.surfaceRow + 2 || nr >= grid.rows - 2) continue;
                if (nc < 1 || nc >= grid.cols - 1) continue;
                if (this.moveTo(nc, nr, grid)) {
                    this.digCount++;
                    return;
                }
            }

            this._pickRandomWalkable(grid);
            if (this.stuckCount > 5) {
                this.state = W_STATE.IDLE;
                this.waitTimer = 2000;
            }
        }

        _getDigPriorities(grid) {
            const dirs = [];
            const d = this.digDirection;
            if (Math.random() < 0.3) {
                dirs.push([0, 1], [d, 1], [d, 0]);
            } else if (Math.random() < 0.15) {
                this.digDirection *= -1;
                dirs.push([-d, 0], [-d, 1], [0, 1]);
            } else {
                dirs.push([d, 0], [d, 1], [0, 1]);
            }
            dirs.push([-d, 0], [0, -1]);
            return dirs;
        }

        // ── 육아: 알/유충 돌봄 (항균 타액 도포, 위치 조정) ──
        _doNurseCare(dt, grid, colony) {
            if (colony.eggs.length === 0) {
                this.state = W_STATE.IDLE;
                this.waitTimer = rand(1500, 3000);
                return;
            }

            // 가장 가까운 알 찾기
            let nearest = colony.eggs[0];
            let nearDist = Infinity;
            for (const egg of colony.eggs) {
                const d = Math.abs(this.col - egg.col) + Math.abs(this.row - egg.row);
                if (d < nearDist) { nearDist = d; nearest = egg; }
            }

            // 알 근처라면 돌봄
            if (nearDist <= 2) {
                this.waitTimer -= dt;
                // 유충 단계면 먹이 주기로 전환
                if (nearest.stage === 'larva' && colony.food > 0) {
                    this.state = W_STATE.NURSE_FEED;
                    this.waitTimer = rand(1500, 3000);
                    return;
                }
                if (this.waitTimer <= 0) {
                    this.state = W_STATE.IDLE;
                    this.waitTimer = rand(2000, 4000);
                }
                return;
            }

            // 알 쪽으로 BFS 이동
            const step = this._getBfsStep(nearest.col, nearest.row, grid);
            if (step) {
                this.moveTo(this.col + step.dc, this.row + step.dr, grid);
            } else {
                this._pickRandomWalkable(grid);
            }
        }

        // ── 육아: 유충에게 먹이 제공 (영양란/타액 분비) ──
        _doNurseFeed(dt, grid, colony) {
            // 유충에게 먹이 전달 시뮬레이션
            this.waitTimer -= dt;
            if (this.waitTimer <= 0) {
                if (colony.food > 0) {
                    colony.food -= 0.5; // 소량의 먹이 소비
                }
                this.state = W_STATE.NURSE_CARE;
                this.waitTimer = rand(2000, 4000);
            }
        }

        // ── 먹이 창고 굴착 (Digger 전용) ──
        _doDigFoodChamber(dt, grid, colony, queen) {
            // 여왕방에서 가로 6칸 옆에 먹이 창고 굴착
            const chamberDir = queen.nestCol < grid.cols / 2 ? 1 : -1;
            const targetCol = queen.nestCol + chamberDir * 6;
            const targetRow = queen.nestRow;

            // 1. 방 영역 내의 '흙' 찾기 (5x2)
            let targetSoil = null;
            let centerDist = Infinity;
            for (let dc = -2; dc <= 2; dc++) {
                for (let dr = -1; dr <= 0; dr++) {
                    const c = targetCol + dc;
                    const r = targetRow + dr;
                    if (grid.isDiggable(c, r)) {
                        const d = Math.abs(this.col - c) + Math.abs(this.row - r);
                        if (d < centerDist) { centerDist = d; targetSoil = { c, r }; }
                    }
                }
            }

            if (!targetSoil) {
                if (!colony.foodChamber) {
                    colony.foodChamber = { col: targetCol, row: targetRow };
                    colony.showEvent('📦 굴착개미가 먹이 창고를 만들었습니다!');
                }
                this.state = W_STATE.IDLE;
                return;
            }

            // 2. 타겟 흙으로 이동 또는 굴착
            if (centerDist <= 1) {
                this.state = W_STATE.DIG_ACTION;
                this.returnState = W_STATE.DIG_FOOD_CHAMBER;
                this.digTarget = targetSoil;
                this.waitTimer = rand(1000, 2000);
            } else {
                const step = this._getBfsStep(targetSoil.c, targetSoil.r, grid);
                if (step) this.moveTo(this.col + step.dc, this.row + step.dr, grid);
                else {
                    const dc = targetSoil.c > this.col ? 1 : -1;
                    const dr = targetSoil.r > this.row ? 1 : -1;
                    if (grid.isDiggable(this.col + dc, this.row)) this.moveTo(this.col + dc, this.row, grid);
                    else if (grid.isDiggable(this.col, this.row + dr)) this.moveTo(this.col, this.row + dr, grid);
                    else this._pickRandomWalkable(grid);
                }
            }
        }

        // ── 경비 순찰 (Guard: 입구 근처) ──
        _doGuardPatrol(dt, grid, queen) {
            const entryCol = queen.entryCol;
            const entryRow = grid.surfaceRow;

            // 입구 근처면 좌우 순찰
            if (Math.abs(this.col - entryCol) < 8 && Math.abs(this.row - entryRow) < 5) {
                // 순찰 이동
                const nc = this.col + this.patrolDir;
                if (grid.isWalkable(nc, this.row) && Math.abs(nc - entryCol) < 10) {
                    this.moveTo(nc, this.row, grid);
                } else {
                    this.patrolDir *= -1;
                    this._pickRandomWalkable(grid);
                }
                this.waitTimer -= dt;
                if (this.waitTimer <= 0) {
                    this.state = W_STATE.IDLE;
                    this.waitTimer = rand(3000, 6000);
                }
                return;
            }

            // 입구로 BFS 이동
            const step = this._getBfsStep(entryCol, entryRow, grid);
            if (step) {
                this.moveTo(this.col + step.dc, this.row + step.dr, grid);
            } else {
                this._pickRandomWalkable(grid);
            }
        }

        // ── 경비: 알 방어 (Guard: 알 주위 머물기) ──
        _doGuardEggs(dt, grid, colony) {
            if (colony.eggs.length === 0) {
                this.state = W_STATE.GUARD_PATROL;
                return;
            }
            const egg = colony.eggs[0];
            if (Math.abs(this.col - egg.col) <= 2 && Math.abs(this.row - egg.row) <= 1) {
                this.waitTimer -= dt;
                if (this.waitTimer <= 0) {
                    this.state = W_STATE.IDLE;
                    this.waitTimer = rand(4000, 8000);
                }
                return;
            }
            const step = this._getBfsStep(egg.col, egg.row, grid);
            if (step) this.moveTo(this.col + step.dc, this.row + step.dr, grid);
            else this._pickRandomWalkable(grid);
        }

        // ── 숫개미: 지표면으로 올라감 (혼인비행 준비) ──
        _doMaleAscend(dt, grid, queen) {
            // 지표면 도달 → 배회
            if (this.row <= grid.surfaceRow) {
                const dc = Math.random() > 0.5 ? 1 : -1;
                this.moveTo(this.col + dc, this.row, grid);
                return;
            }
            // BFS로 올라감
            const step = this._getBfsStep(queen.entryCol, grid.surfaceRow, grid);
            if (step) {
                this.moveTo(this.col + step.dc, this.row + step.dr, grid);
            } else {
                if (grid.isWalkable(this.col, this.row - 1)) {
                    this.moveTo(this.col, this.row - 1, grid);
                } else {
                    this._pickRandomWalkable(grid);
                }
            }
        }

        // ── 순찰: 터널 내 돌아다님 ──
        _doWander(dt, grid) {
            this.waitTimer -= dt;
            if (this.waitTimer <= 0) {
                this.energy -= 0.5; // 소모
                this.state = W_STATE.IDLE;
                this.waitTimer = rand(1500, 3000);
                return;
            }
            this._pickRandomWalkable(grid);
        }

        // ── 굴착 수행 (공통 액션) ──
        _doDigAction(dt, grid, colony) {
            this.waitTimer -= dt;
            if (this.waitTimer <= 0) {
                if (this.digTarget && grid.isDiggable(this.digTarget.c, this.digTarget.r)) {
                    grid.set(this.digTarget.c, this.digTarget.r, EMPTY);
                    this.digCount++;
                    this.energy -= 0.5;
                    // 효과음 등 추가 가능
                }
                this.state = this.returnState || W_STATE.IDLE;
            }
        }

        // ── 보육방/휴식방 굴착 (Digger) ──
        _doDigNursery(dt, grid, colony, queen) {
            const targetRow = grid.surfaceRow + 10;
            const targetCol = Math.floor(grid.cols / 2) + 5;

            // 1. 방 영역 내의 '흙' 찾기
            let targetSoil = null;
            let centerDist = Infinity;

            for (let r = targetRow - 1; r <= targetRow + 1; r++) {
                for (let c = targetCol - 1; c <= targetCol + 1; c++) {
                    if (grid.isDiggable(c, r)) {
                        // 중심에서 가까운 순? 아니면 그냥 발견 순?
                        // 여기선 "개미에게서 가장 가까운" 흙을 찾자 (자연스러운 확장)
                        const d = Math.abs(this.col - c) + Math.abs(this.row - r);
                        // 단, 너무 멀면(방 반대편) 안될수도 있으니... 
                        // 그냥 방의 흙 중 하나를 타겟팅
                        if (d < centerDist) { centerDist = d; targetSoil = { c, r }; }
                    }
                }
            }

            if (!targetSoil) {
                // 당장 팔 흙이 없음 -> 방 완성 체크?
                if (!colony.nurseryChamber) {
                    colony.nurseryChamber = { col: targetCol, row: targetRow };
                    colony.showEvent('👶 보육방이 건설되었습니다!');
                }
                this.state = W_STATE.IDLE;
                return;
            }

            // 2. 타겟 흙으로 이동 또는 굴착
            if (centerDist <= 1) {
                // 바로 옆: 굴착 시작
                this.state = W_STATE.DIG_ACTION;
                this.returnState = W_STATE.DIG_NURSERY;
                this.digTarget = targetSoil;
                this.waitTimer = rand(1000, 2000); // 1~2초 굴착
            } else {
                // 이동
                const step = this._getBfsStep(targetSoil.c, targetSoil.r, grid);
                if (step) {
                    this.moveTo(this.col + step.dc, this.row + step.dr, grid);
                } else {
                    // BFS 실패 시 (벽으로 막힘 등) -> 타겟 방향으로 직접 굴착 이동
                    // (이동 중 굴착은 즉시 처리되지만 어쩔 수 없음, 방 내부 굴착이 메인)
                    const dc = targetSoil.c > this.col ? 1 : -1;
                    const dr = targetSoil.r > this.row ? 1 : -1;
                    if (grid.isDiggable(this.col + dc, this.row)) this.moveTo(this.col + dc, this.row, grid);
                    else if (grid.isDiggable(this.col, this.row + dr)) this.moveTo(this.col, this.row + dr, grid);
                    else this._pickRandomWalkable(grid);
                }
            }
        }

        _doDigResting(dt, grid, colony, queen) {
            const targetRow = grid.rows - 6;
            const targetCol = Math.floor(grid.cols / 2) - 5;

            // 로직 동일 (함수화 가능하지만 일단 복사)
            let targetSoil = null;
            let minDist = Infinity;
            for (let r = targetRow - 1; r <= targetRow + 1; r++) {
                for (let c = targetCol - 1; c <= targetCol + 1; c++) {
                    if (grid.isDiggable(c, r)) {
                        const d = Math.abs(this.col - c) + Math.abs(this.row - r);
                        if (d < minDist) { minDist = d; targetSoil = { c, r }; }
                    }
                }
            }

            if (!targetSoil) {
                if (!colony.restingChamber) {
                    colony.restingChamber = { col: targetCol, row: targetRow };
                    colony.showEvent('💤 휴식방이 건설되었습니다!');
                }
                this.state = W_STATE.IDLE;
                return;
            }

            if (minDist <= 1) {
                this.state = W_STATE.DIG_ACTION;
                this.returnState = W_STATE.DIG_RESTING;
                this.digTarget = targetSoil;
                this.waitTimer = rand(1000, 2000);
            } else {
                const step = this._getBfsStep(targetSoil.c, targetSoil.r, grid);
                if (step) this.moveTo(this.col + step.dc, this.row + step.dr, grid);
                else {
                    const dc = targetSoil.c > this.col ? 1 : -1;
                    const dr = targetSoil.r > this.row ? 1 : -1;
                    if (grid.isDiggable(this.col + dc, this.row)) this.moveTo(this.col + dc, this.row, grid);
                    else if (grid.isDiggable(this.col, this.row + dr)) this.moveTo(this.col, this.row + dr, grid);
                    else this._pickRandomWalkable(grid);
                }
            }
        }

        // ── 알 운반 (Nurse) ──
        _doNurseTransport(dt, grid, colony) {
            if (!colony.nurseryChamber) {
                this.state = W_STATE.IDLE;
                return;
            }

            // 1. 알/유충을 안 들고 있으면 -> 보육방 밖에 있는 알 찾기
            if (!this.carryingFood) { // carryingFood 변수 재사용 (이름은 Food지만 물체 운반)
                const unsafeEgg = colony.eggs.find(e =>
                    Math.abs(e.col - colony.nurseryChamber.col) > 3 || Math.abs(e.row - colony.nurseryChamber.row) > 3
                );

                if (unsafeEgg) {
                    if (Math.abs(this.col - unsafeEgg.col) <= 1 && Math.abs(this.row - unsafeEgg.row) <= 1) {
                        // 픽업
                        this.carryingFood = unsafeEgg; // 참조 저장
                        // 알을 리스트에서 잠시 제거하거나 상태 변경? 
                        // 여기선 단순화를 위해 시각적으로만 들고 있는 척하고, 알 좌표를 개미 따라다니게 함
                        this.state = W_STATE.NURSE_TRANSPORT;
                    } else {
                        const step = this._getBfsStep(unsafeEgg.col, unsafeEgg.row, grid);
                        if (step) this.moveTo(this.col + step.dc, this.row + step.dr, grid);
                        else this._pickRandomWalkable(grid);
                    }
                } else {
                    this.state = W_STATE.IDLE;
                }
            } else {
                // 2. 들고 있으면 -> 보육방으로 이동
                const target = colony.nurseryChamber;
                if (Math.abs(this.col - target.col) <= 1 && Math.abs(this.row - target.row) <= 1) {
                    // 도착: 내려놓기
                    const egg = this.carryingFood;
                    egg.col = this.col;
                    egg.row = this.row;
                    this.carryingFood = null;
                    this.state = W_STATE.NURSE_CARE;
                } else {
                    const step = this._getBfsStep(target.col, target.row, grid);
                    if (step) this.moveTo(this.col + step.dc, this.row + step.dr, grid);
                    else this._pickRandomWalkable(grid);

                    // 들고 있는 알 위치 동기화
                    if (this.carryingFood) {
                        this.carryingFood.col = this.col;
                        this.carryingFood.row = this.row - 1;
                    }
                }
            }
            this.energy -= 0.1;
        }

        // ── 피로 회복 ──
        _doTiredReturn(dt, grid, colony) {
            const target = colony.restingChamber || { col: Math.floor(grid.cols / 2), row: grid.rows - 2 };

            if (Math.abs(this.col - target.col) <= 2 && Math.abs(this.row - target.row) <= 2) {
                this.state = W_STATE.SLEEPING;
            } else {
                const step = this._getBfsStep(target.col, target.row, grid);
                if (step) this.moveTo(this.col + step.dc, this.row + step.dr, grid);
                else this._pickRandomWalkable(grid);
            }
        }

        _doSleep(dt) {
            this.energy += dt * 0.05; // 초당 50 회복 (약 2초 수면)
            if (this.energy >= this.maxEnergy) {
                this.energy = this.maxEnergy;
                this.state = W_STATE.IDLE;
            }
        }

        // ── BFS 경로 캐시 (매 프레임 BFS 방지) ──
        _getBfsStep(targetCol, targetRow, grid) {
            // 캐시 유효: 같은 목표이고 최근에 계산
            const same = this._pathTarget &&
                this._pathTarget.col === targetCol &&
                this._pathTarget.row === targetRow;

            if (same && this._pathStep && this._pathAge < 5) {
                // 캐시 결과가 유효하면 그 방향의 셀이 여전히 걸을 수 있는지 확인
                const nc = this.col + this._pathStep.dc;
                const nr = this.row + this._pathStep.dr;
                if (grid.isWalkable(nc, nr)) {
                    return this._pathStep;
                }
            }

            // 새로 BFS
            this._pathTarget = { col: targetCol, row: targetRow };
            this._pathAge = 0;
            this._pathStep = bfsNextStep(this.col, this.row, targetCol, targetRow, grid);
            return this._pathStep;
        }

        _pickRandomWalkable(grid) {
            const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
            const shuffled = dirs.sort(() => Math.random() - 0.5);
            // 지지력 있는 방향 우선
            let fallbackDc = 0, fallbackDr = 0, found = false;
            for (const [dc, dr] of shuffled) {
                const nc = this.col + dc, nr = this.row + dr;
                if (grid.isWalkable(nc, nr)) {
                    if (grid.hasSupport(nc, nr)) {
                        this.moveTo(nc, nr, grid);
                        return true;
                    }
                    if (!found) { fallbackDc = dc; fallbackDr = dr; found = true; }
                }
            }
            // 지지력 없어도 걸을 수 있는 곳으로
            if (found) {
                this.moveTo(this.col + fallbackDc, this.row + fallbackDr, grid);
                return true;
            }
            return false;
        }
    }

    // ─── Colony ───
    class Colony {
        constructor() {
            this.food = 0;
            this.eggs = [];
            this.deliveries = 0;
            this.foodChamber = null;      // {col, row} 먹이 창고 위치
            this.nurseryChamber = null;   // {col, row} 보육방 위치
            this.restingChamber = null;   // {col, row} 휴식방 위치
            this.storedFoodItems = [];    // 먹이 창고 시각화용
            this._eventMsg = '';
            this._eventTimer = 0;
        }
        get workerCount() { return game.workers.length; }
        showEvent(msg) {
            this._eventMsg = msg;
            this._eventTimer = 3000;
            const el = document.getElementById('event-msg');
            el.textContent = msg;
            el.classList.add('show');
            clearTimeout(this._fadeTimeout);
            this._fadeTimeout = setTimeout(() => el.classList.remove('show'), 2800);
        }
    }

    // ─── Main Game ───
    // ─── Ambient Music System ───
    class AmbientMusic {
        constructor() {
            this.ctx = null;
            this.isPlaying = false;
            this.mode = 0; // 0:Off, 1:Happy, 2:Cafe, 3:Dark
            this.masterGain = null;
            this.nodes = [];
            this.timer = null;
        }

        init() {
            if (!this.ctx) {
                this.ctx = new (window.AudioContext || window.webkitAudioContext)();
                this.masterGain = this.ctx.createGain();
                this.masterGain.gain.value = 0.3;
                this.masterGain.connect(this.ctx.destination);
            }
        }

        setMode(mode) {
            this.stop(); // Stop current
            this.mode = mode;
            if (this.mode > 0) this.start();
        }

        start() {
            this.init();
            if (this.ctx.state === 'suspended') this.ctx.resume();
            this.isPlaying = true;

            if (this.mode === 3) this._playDarkDrone(); // Dark only
            this._scheduleNext();
        }

        _scheduleNext() {
            if (!this.isPlaying) return;

            let delay = 1000;
            if (this.mode === 1) delay = this._playHappy();
            else if (this.mode === 2) delay = this._playCafe();
            else if (this.mode === 3) delay = this._playDark();

            this.timer = setTimeout(() => this._scheduleNext(), delay);
        }

        // ─── 1. Happy: C Major Pentatonic, Fast, Bouncy ───
        _playHappy() {
            const notes = [523.25, 587.33, 659.25, 783.99, 880.00, 1046.50]; // C5, D5, E5, G5, A5, C6
            const note = notes[Math.floor(Math.random() * notes.length)];
            const time = this.ctx.currentTime;

            const osc = this.ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = note;

            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(0.1, time + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.001, time + 0.4); // Short pluck

            osc.connect(gain);
            gain.connect(this.masterGain);
            osc.start(time);
            osc.stop(time + 0.5);
            this.nodes.push(osc, gain);

            // Fast tempo: 200-500ms
            return Math.random() * 300 + 200;
        }

        // ─── 2. Cafe: Major 7th Chords, Electric Piano, Chill ───
        _playCafe() {
            // Root notes: C, F, G, Am
            const roots = [261.63, 349.23, 392.00, 220.00];
            const root = roots[Math.floor(Math.random() * roots.length)];

            // Build Major 7 or Minor 7 chord
            const isMinor = root === 220.00;
            const third = root * (isMinor ? 1.189 : 1.259); // m3 or M3
            const fifth = root * 1.498; // P5
            const seventh = root * (isMinor ? 1.781 : 1.887); // m7 or M7

            const chord = [root, third, fifth, seventh];
            const time = this.ctx.currentTime;

            chord.forEach((freq, i) => {
                // Electric piano simulation (Triangle + slight detune)
                const osc = this.ctx.createOscillator();
                osc.type = 'triangle';
                osc.frequency.value = freq;

                const gain = this.ctx.createGain();
                const vel = 0.05 - (i * 0.005); // Lower notes louder
                gain.gain.setValueAtTime(0, time);
                gain.gain.linearRampToValueAtTime(vel, time + 0.1);
                gain.gain.exponentialRampToValueAtTime(0.001, time + 1.5);

                osc.connect(gain);
                gain.connect(this.masterGain);
                osc.start(time);
                osc.stop(time + 2.0);
                this.nodes.push(osc, gain);
            });

            // Slow tempo: 1500-3000ms
            return Math.random() * 1500 + 1500;
        }

        // ─── 3. Dark: Drone + Minor Pentatonic (Original) ───
        _playDarkDrone() {
            const osc = this.ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.value = 55; // A1
            const gain = this.ctx.createGain();
            gain.gain.value = 0.15;
            const lpf = this.ctx.createBiquadFilter();
            lpf.type = 'lowpass';
            lpf.frequency.value = 200;
            osc.connect(lpf);
            lpf.connect(gain);
            gain.connect(this.masterGain);
            osc.start();
            this.nodes.push(osc, gain, lpf);
        }

        _playDark() {
            const notes = [196.00, 261.63, 311.13, 392.00, 523.25]; // G3, C4, Eb4, G4, C5
            const note = notes[Math.floor(Math.random() * notes.length)];
            const time = this.ctx.currentTime;

            const osc = this.ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = note;

            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(0.1, time + 2);
            gain.gain.exponentialRampToValueAtTime(0.001, time + 6);

            const panner = this.ctx.createStereoPanner();
            panner.pan.value = Math.random() * 2 - 1;

            osc.connect(gain);
            gain.connect(panner);
            panner.connect(this.masterGain);

            osc.start(time);
            osc.stop(time + 6.5);
            this.nodes.push(osc, gain, panner);

            return Math.random() * 4000 + 3000;
        }

        stop() {
            this.isPlaying = false;
            if (this.timer) clearTimeout(this.timer);
            this.nodes.forEach(n => { try { n.stop(); } catch (e) { } try { n.disconnect(); } catch (e) { } });
            this.nodes = [];
            if (this.ctx) this.ctx.suspend();
        }
    }

    const game = {
        canvas: null,
        ctx: null,
        width: 0,
        height: 0,
        grid: null,
        bgm: null, // AmbientMusic instance
        queen: null,
        workers: [],
        foods: [],
        colony: null,
        lastTime: 0,
        elapsed: 0,
        speedMult: 1,
        paused: false,
        foodSpawnTimer: FOOD_SPAWN_INTERVAL * 0.5,
        // Pre-rendered soil canvas for performance
        soilCanvas: null,
        soilCtx: null,
        soilDirty: true,

        init() {
            this.canvas = document.getElementById('game-canvas');
            this.ctx = this.canvas.getContext('2d');
            this.soilCanvas = document.createElement('canvas');
            this.soilCtx = this.soilCanvas.getContext('2d', { alpha: true });
            this._resize();
            window.addEventListener('resize', () => {
                this._resize();
                this._rebuildGrid();
            });

            this._buildGrid();

            this.colony = new Colony();

            // Queen starts on the surface near center
            const startCol = Math.floor(this.grid.cols / 2);
            const startRow = this.grid.surfaceRow;
            this.queen = new QueenAnt(startCol, startRow);
            this.queen.x = startCol * CELL + CELL / 2;
            this.queen.y = startRow * CELL + CELL / 2;

            this.colony.showEvent('👑 여왕개미가 지면에 도착했습니다!');

            // Initial surface food
            for (let i = 0; i < 4; i++) this._spawnSurfaceFood();

            // Canvas click → place food
            this.canvas.addEventListener('click', (e) => this._onClick(e));

            // Controls
            document.getElementById('btn-speed').addEventListener('click', () => this._toggleSpeed());
            document.getElementById('btn-bgm').addEventListener('click', () => this._toggleBGM());
            document.getElementById('btn-pause').addEventListener('click', () => this._togglePause());

            // Start BGM system (muted initially)
            this.bgm = new AmbientMusic();

            // Start
            this.lastTime = performance.now();
            requestAnimationFrame((t) => this._loop(t));
        },

        _resize() {
            const dpr = window.devicePixelRatio || 1;
            const container = document.getElementById('farm-frame');
            const rect = container.getBoundingClientRect();
            this.width = Math.floor(rect.width);
            this.height = Math.floor(rect.height);
            this.canvas.width = this.width * dpr;
            this.canvas.height = this.height * dpr;
            this.canvas.style.width = this.width + 'px';
            this.canvas.style.height = this.height + 'px';
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            if (this.soilCanvas) {
                this.soilCanvas.width = this.width * dpr;
                this.soilCanvas.height = this.height * dpr;
                this.soilCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }
            this.soilDirty = true;
        },

        _buildGrid() {
            const cols = Math.floor(this.width / CELL);
            const rows = Math.floor(this.height / CELL);
            const surfaceRow = Math.floor(rows * SURFACE_RATIO);
            this.grid = new Grid(cols, rows, surfaceRow);
            this.soilDirty = true;
        },

        _rebuildGrid() {
            // 리사이즈/회전 시 기존 그리드 데이터 완전 보존
            const oldGrid = this.grid;
            const newCols = Math.floor(this.width / CELL);
            const newRows = Math.floor(this.height / CELL);

            // 크기가 같으면 아무것도 안 함
            if (oldGrid && newCols === oldGrid.cols && newRows === oldGrid.rows) {
                this.soilDirty = true;
                return;
            }

            const newSurfaceRow = Math.floor(newRows * SURFACE_RATIO);
            const newGrid = new Grid(newCols, newRows, newSurfaceRow);

            if (oldGrid) {
                const copyC = Math.min(oldGrid.cols, newCols);
                const copyR = Math.min(oldGrid.rows, newRows);

                // 1) 기존 셀 전체 복사 (무조건)
                for (let r = 0; r < copyR; r++) {
                    for (let c = 0; c < copyC; c++) {
                        newGrid.set(c, r, oldGrid.get(c, r));
                    }
                }

                // 2) 새 하늘 영역 덮어쓰기 (newSurfaceRow 위)
                for (let r = 0; r < newSurfaceRow; r++) {
                    for (let c = 0; c < newCols; c++) {
                        newGrid.set(c, r, EMPTY);
                    }
                }

                // 3) 새 지표면 행 설정
                for (let c = 0; c < newCols; c++) {
                    newGrid.set(c, newSurfaceRow, SURFACE);
                }

                // 4) 이전 지하 터널을 새 위치에 매핑
                //    surfaceRow 차이만큼 오프셋 적용
                const rowOffset = newSurfaceRow - oldGrid.surfaceRow;
                if (rowOffset !== 0) {
                    // 이전 지하 영역(oldSurfaceRow+1 ~ oldRows-1)을 새 위치로 복사
                    const oldUnderStart = oldGrid.surfaceRow + 1;
                    const oldUnderEnd = oldGrid.rows;
                    for (let r = oldUnderStart; r < oldUnderEnd; r++) {
                        const newR = r + rowOffset;
                        if (newR < 0 || newR >= newRows) continue;
                        if (newR <= newSurfaceRow) continue; // 하늘/지표면과 겹치면 건너뜀
                        for (let c = 0; c < copyC; c++) {
                            newGrid.set(c, newR, oldGrid.get(c, r));
                        }
                    }

                    // 오프셋된 영역과 지표면 사이의 갭을 흙으로 채움
                    const gapStart = newSurfaceRow + 1;
                    const gapEnd = Math.min(oldUnderStart + rowOffset, newRows);
                    for (let r = gapStart; r < gapEnd; r++) {
                        for (let c = 0; c < newCols; c++) {
                            if (newGrid.get(c, r) === EMPTY) {
                                newGrid.set(c, r, SOIL);
                            }
                        }
                    }
                }
            }

            this.grid = newGrid;

            // 개미들이 새 그리드 범위 안에 있도록 클램프 + 오프셋
            const rowOff = oldGrid ? (newSurfaceRow - oldGrid.surfaceRow) : 0;
            const clampAnt = (ant) => {
                // 지하에 있었으면 오프셋 적용
                if (oldGrid && ant.row > oldGrid.surfaceRow) {
                    ant.row = Math.max(newSurfaceRow + 1, Math.min(ant.row + rowOff, newRows - 2));
                    ant.targetRow = Math.max(newSurfaceRow + 1, Math.min(ant.targetRow + rowOff, newRows - 2));
                }
                ant.col = Math.max(0, Math.min(ant.col, newCols - 2));
                ant.row = Math.max(0, Math.min(ant.row, newRows - 2));
                ant.targetCol = Math.max(0, Math.min(ant.targetCol, newCols - 2));
                ant.targetRow = Math.max(0, Math.min(ant.targetRow, newRows - 2));
                ant.x = ant.col * CELL + CELL / 2;
                ant.y = ant.row * CELL + CELL / 2;
                ant.moving = false;
                ant.digging = false;
            };
            if (this.queen) {
                clampAnt(this.queen);
                // 여왕 관련 위치 업데이트
                if (oldGrid && this.queen.nestRow) {
                    this.queen.nestRow = Math.max(newSurfaceRow + 1, Math.min(this.queen.nestRow + rowOff, newRows - 2));
                }
            }
            for (const w of this.workers) clampAnt(w);
            // 알 클램프
            for (const egg of this.colony.eggs) {
                if (oldGrid && egg.row > oldGrid.surfaceRow) {
                    egg.row = Math.max(newSurfaceRow + 1, Math.min(egg.row + rowOff, newRows - 2));
                }
                egg.col = Math.max(0, Math.min(egg.col, newCols - 2));
                egg.row = Math.max(0, Math.min(egg.row, newRows - 2));
            }
            // 먹이 창고 위치 업데이트
            if (this.colony.foodChamber) {
                const fc = this.colony.foodChamber;
                fc.row = Math.max(newSurfaceRow + 1, Math.min(fc.row + rowOff, newRows - 2));
                fc.col = Math.max(0, Math.min(fc.col, newCols - 2));
            }

            this.soilDirty = true;
        },

        _spawnSurfaceFood() {
            const margin = 30;
            const x = rand(margin, this.width - margin);
            const y = this.grid.surfaceRow * CELL - rand(2, 10);
            this.foods.push(new FoodItem(x, y, randInt(3, 8)));
        },

        _onClick(e) {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            // Place food on surface
            const surfaceY = this.grid.surfaceRow * CELL;
            this.foods.push(new FoodItem(x, Math.min(y, surfaceY - 2), randInt(4, 9)));
            this.colony.showEvent('🍎 관찰자가 음식을 놓았습니다!');
        },

        _toggleSpeed() {
            const speeds = [1, 2, 4, 8];
            const idx = (speeds.indexOf(this.speedMult) + 1) % speeds.length;
            this.speedMult = speeds[idx];
            document.getElementById('btn-speed').textContent = `⏩ x${this.speedMult}`;
        },

        _togglePause() {
            this.paused = !this.paused;
            document.getElementById('btn-pause').textContent = this.paused ? '▶️' : '⏸️';
        },

        // ─── Loop ───
        _loop(time) {
            requestAnimationFrame((t) => this._loop(t));
            if (this.paused) { this.lastTime = time; return; }

            const rawDt = Math.min(time - this.lastTime, 80);
            const dt = rawDt * this.speedMult;
            this.lastTime = time;
            this.elapsed += dt;

            this._update(dt);
            this._render(time);
            this._updateHUD();
        },

        _update(dt) {
            const grid = this.grid;
            const colony = this.colony;

            // Queen AI
            this.queen.think(dt, grid, colony);
            this.queen.update(dt, grid);

            // Workers AI
            for (const w of this.workers) {
                w.think(dt, grid, colony, this.foods, this.queen);
                w.update(dt, grid);
            }

            // Eggs hatch
            for (const egg of colony.eggs) {
                egg.update(dt);
                if (egg.hatched) {
                    let caste;
                    if (egg.isNanitic) {
                        // 나니틱은 채집 또는 육아만
                        caste = Math.random() < 0.5 ? CASTE.FORAGER : CASTE.NURSE;
                    } else {
                        caste = assignCaste(colony);
                    }
                    const worker = new WorkerAnt(egg.col, egg.row, caste);
                    if (egg.isNanitic) {
                        worker.speed = WORKER_SPEED * 0.8;
                        worker.isNanitic = true;
                        this.queen.naniticsHatched++;
                        colony.showEvent(`🐜 나니틱(첫 세대) 부화! (${this.queen.naniticsHatched}/${NANITICS_COUNT})`);
                    } else {
                        const casteNames = { forager: '채집', digger: '굴착', nurse: '육아', guard: '경비', male: '숫개미' };
                        colony.showEvent(`🐜 ${casteNames[caste]} 개미가 부화했습니다!`);
                    }
                    this.workers.push(worker);
                }
            }
            colony.eggs = colony.eggs.filter(e => !e.hatched);

            // Remove depleted food
            this.foods = this.foods.filter(f => !f.depleted);

            // Auto spawn food on surface
            this.foodSpawnTimer -= dt;
            if (this.foodSpawnTimer <= 0) {
                this._spawnSurfaceFood();
                this.foodSpawnTimer = FOOD_SPAWN_INTERVAL;
                colony.showEvent('🍃 지표면에 먹이가 나타났습니다');
            }

            // Mark soil canvas dirty (tunnels change)
            // this.soilDirty = true; // Use partial updates through grid.dirtyCells instead
        },

        // ─── Render ───
        _render(time) {
            const ctx = this.ctx;
            const W = this.width;
            const H = this.height;
            const grid = this.grid;

            // Sky gradient
            const skyH = grid.surfaceRow * CELL;
            const skyGrad = ctx.createLinearGradient(0, 0, 0, skyH);
            skyGrad.addColorStop(0, '#3a7bbf');
            skyGrad.addColorStop(0.6, '#6aafe6');
            skyGrad.addColorStop(1, '#a8d8f0');
            ctx.fillStyle = skyGrad;
            ctx.fillRect(0, 0, W, skyH);

            // Simple clouds
            ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
            const cloudOffset = (time * 0.008) % (W + 200);
            this._drawCloud(ctx, cloudOffset - 100, skyH * 0.25, 40);
            this._drawCloud(ctx, (cloudOffset + W * 0.5) % (W + 200) - 100, skyH * 0.4, 30);

            // Sun
            ctx.fillStyle = 'rgba(255, 220, 100, 0.3)';
            ctx.beginPath();
            ctx.arc(W - 60, 35, 22, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'rgba(255, 240, 150, 0.6)';
            ctx.beginPath();
            ctx.arc(W - 60, 35, 14, 0, Math.PI * 2);
            ctx.fill();

            // Grass line
            ctx.fillStyle = '#4a8c3f';
            ctx.fillRect(0, skyH - 3, W, 5);
            // Grass blades
            ctx.strokeStyle = '#5ca04e';
            ctx.lineWidth = 1;
            for (let x = 0; x < W; x += 6) {
                const h = 4 + Math.sin(x * 0.3 + time * 0.002) * 2;
                ctx.beginPath();
                ctx.moveTo(x, skyH);
                ctx.lineTo(x + 2, skyH - h);
                ctx.stroke();
            }

            // Offscreen Canvas for Soil and Tunnels
            if (this.soilDirty) {
                this.soilCtx.clearRect(0, 0, this.width, this.height);
                this._drawSoil(this.soilCtx, grid, time);
                this._drawTunnelEdges(this.soilCtx, grid);
                this.soilDirty = false;
                grid.dirtyCells = [];
            } else if (grid.dirtyCells.length > 0) {
                this._updateDirtySoil(this.soilCtx, grid);
            }
            
            // Draw pre-rendered soil on main canvas
            ctx.drawImage(this.soilCanvas, 0, 0, this.width, this.height);

            // Eggs
            this._drawEggs(ctx, grid);

            // Food on surface
            this._drawFoods(ctx, time);

            // Chambers
            const nc = this.colony.nurseryChamber;
            if (nc) {
                ctx.fillStyle = 'rgba(200, 100, 100, 0.15)';
                ctx.fillRect((nc.col - 2) * CELL, (nc.row - 1) * CELL, 4 * CELL, 3 * CELL);
                ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
                ctx.textAlign = 'center';
                ctx.font = '20px serif';
                ctx.fillText('👶', nc.col * CELL, nc.row * CELL + 5);
                ctx.textAlign = 'start';
            }
            const rc = this.colony.restingChamber;
            if (rc) {
                ctx.fillStyle = 'rgba(100, 100, 200, 0.15)';
                ctx.fillRect((rc.col - 2) * CELL, (rc.row - 1) * CELL, 4 * CELL, 3 * CELL);
                ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
                ctx.textAlign = 'center';
                ctx.font = '20px serif';
                ctx.fillText('💤', rc.col * CELL, rc.row * CELL + 5);
                ctx.textAlign = 'start';
            }

            // Food chamber stored items
            const fc = this.colony.foodChamber;
            if (fc) {
                // 먹이 창고 배경 표시
                ctx.fillStyle = 'rgba(80, 120, 60, 0.15)';
                ctx.fillRect((fc.col - 3) * CELL, (fc.row - 1) * CELL, 6 * CELL, 2 * CELL);
                // 저장된 식량 아이템
                for (const item of this.colony.storedFoodItems) {
                    const pulse = 1 + Math.sin(time * 0.002 + item.col) * 0.1;
                    ctx.fillStyle = 'rgba(126, 207, 92, 0.7)';
                    ctx.beginPath();
                    ctx.arc(item.col * CELL + 2, item.row * CELL + 2, (2 + item.size * 3) * pulse, 0, Math.PI * 2);
                    ctx.fill();
                }
                // "창고" 라벨 (작은 표시)
                ctx.fillStyle = 'rgba(255,255,255,0.3)';
                ctx.font = '6px sans-serif';
                ctx.fillText('📦', (fc.col - 2) * CELL, (fc.row - 1) * CELL - 1);
            }

            // Workers (카스트별 색상)
            const casteColors = {
                forager: '#c8a878',  // 갈색
                digger: '#a08060',   // 진한 갈색
                nurse: '#d8b898',    // 밝은 색
                guard: '#9a6040',    // 붉은 갈색
                male: '#d4b040',     // 금색
            };
            for (const w of this.workers) {
                const baseColor = w.isNanitic ? '#b89868' : (casteColors[w.caste] || '#c8a878');
                const scale = w.isNanitic ? 0.7 : (w.caste === CASTE.GUARD ? 1.1 : 1);
                this._drawAnt(ctx, w, baseColor, w.carryingFood, time, false, scale);
                // 숫개미 날개 표시
                if (w.hasWings) {
                    ctx.fillStyle = 'rgba(200, 200, 255, 0.4)';
                    ctx.beginPath();
                    ctx.ellipse(w.x - 1, w.y - 3, 3, 1.5, -0.3, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.beginPath();
                    ctx.ellipse(w.x + 1, w.y - 3, 3, 1.5, 0.3, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            // Queen
            this._drawAnt(ctx, this.queen, '#d4763a', false, time, true);

            // Sealed entrance marker
            if (this.queen.sealCol >= 0 && this.queen.state === Q_STATE.CLAUSTRAL) {
                const sx = this.queen.sealCol * CELL;
                const sy = this.queen.sealRow * CELL;
                ctx.fillStyle = 'rgba(100, 70, 40, 0.9)';
                ctx.fillRect(sx, sy, CELL, CELL);
                ctx.fillStyle = 'rgba(80, 55, 30, 0.7)';
                ctx.fillRect(sx, sy, CELL, CELL * 0.5);
            }

            // Glass reflection effect
            ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
            ctx.fillRect(0, 0, W * 0.03, H);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.008)';
            ctx.fillRect(W * 0.06, 0, W * 0.01, H);
        },

        _updateDirtySoil(sCtx, grid) {
            const toUpdate = new Set();
            for (const cell of grid.dirtyCells) {
                toUpdate.add(`${cell.c},${cell.r}`);
                toUpdate.add(`${cell.c - 1},${cell.r}`);
                toUpdate.add(`${cell.c + 1},${cell.r}`);
                toUpdate.add(`${cell.c},${cell.r - 1}`);
                toUpdate.add(`${cell.c},${cell.r + 1}`);
            }
            grid.dirtyCells = [];

            for (const key of toUpdate) {
                const [c, r] = key.split(',').map(Number);
                if (c < 0 || c >= grid.cols || r < grid.surfaceRow || r >= grid.rows) continue;
                
                const x = c * CELL;
                const y = r * CELL;
                sCtx.clearRect(x, y, CELL, CELL);
                
                const cellVal = grid.get(c, r);
                if (cellVal === SOIL || cellVal === SURFACE) {
                    const n = grid.noise[grid.idx(c, r)];
                    sCtx.fillStyle = soilColor(r - grid.surfaceRow, grid.rows - grid.surfaceRow, n);
                    sCtx.fillRect(x, y, CELL, CELL);
                } else if (cellVal === BEDROCK) {
                    const n = grid.noise[grid.idx(c, r)];
                    sCtx.fillStyle = `rgb(${45 + n * 10}, ${40 + n * 8}, ${35 + n * 6})`;
                    sCtx.fillRect(x, y, CELL, CELL);
                } else if (cellVal === EMPTY && r > grid.surfaceRow) {
                    sCtx.fillStyle = 'rgba(8, 5, 2, 0.95)';
                    sCtx.fillRect(x, y, CELL, CELL);
                }
            }
            
            sCtx.strokeStyle = 'rgba(100, 75, 45, 0.3)';
            sCtx.lineWidth = 0.5;
            for (const key of toUpdate) {
                const [c, r] = key.split(',').map(Number);
                if (c < 0 || c >= grid.cols || r <= grid.surfaceRow || r >= grid.rows) continue;
                if (grid.get(c, r) !== EMPTY) continue;
                
                const x = c * CELL;
                const y = r * CELL;
                sCtx.beginPath();
                if (grid.get(c - 1, r) === SOIL || grid.get(c - 1, r) === BEDROCK) {
                    sCtx.moveTo(x, y); sCtx.lineTo(x, y + CELL);
                }
                if (grid.get(c + 1, r) === SOIL || grid.get(c + 1, r) === BEDROCK) {
                    sCtx.moveTo(x + CELL, y); sCtx.lineTo(x + CELL, y + CELL);
                }
                if (grid.get(c, r - 1) === SOIL) {
                    sCtx.moveTo(x, y); sCtx.lineTo(x + CELL, y);
                }
                if (grid.get(c, r + 1) === SOIL || grid.get(c, r + 1) === BEDROCK) {
                    sCtx.moveTo(x, y + CELL); sCtx.lineTo(x + CELL, y + CELL);
                }
                sCtx.stroke();
            }
        },

        _drawCloud(ctx, x, y, size) {
            ctx.beginPath();
            ctx.arc(x, y, size * 0.5, 0, Math.PI * 2);
            ctx.arc(x + size * 0.4, y - size * 0.15, size * 0.35, 0, Math.PI * 2);
            ctx.arc(x + size * 0.8, y, size * 0.45, 0, Math.PI * 2);
            ctx.fill();
        },

        _drawSoil(ctx, grid, time) {
            for (let r = grid.surfaceRow; r < grid.rows; r++) {
                for (let c = 0; c < grid.cols; c++) {
                    const cell = grid.get(c, r);
                    const x = c * CELL;
                    const y = r * CELL;

                    if (cell === SOIL || cell === SURFACE) {
                        const n = grid.noise[grid.idx(c, r)];
                        ctx.fillStyle = soilColor(r - grid.surfaceRow, grid.rows - grid.surfaceRow, n);
                        ctx.fillRect(x, y, CELL, CELL);
                    } else if (cell === BEDROCK) {
                        const n = grid.noise[grid.idx(c, r)];
                        ctx.fillStyle = `rgb(${45 + n * 10}, ${40 + n * 8}, ${35 + n * 6})`;
                        ctx.fillRect(x, y, CELL, CELL);
                    } else if (cell === EMPTY && r > grid.surfaceRow) {
                        // Tunnel background - darker
                        ctx.fillStyle = 'rgba(8, 5, 2, 0.95)';
                        ctx.fillRect(x, y, CELL, CELL);
                    }
                }
            }
        },

        _drawTunnelEdges(ctx, grid) {
            ctx.strokeStyle = 'rgba(100, 75, 45, 0.3)';
            ctx.lineWidth = 0.5;
            for (let r = grid.surfaceRow + 1; r < grid.rows; r++) {
                for (let c = 0; c < grid.cols; c++) {
                    if (grid.get(c, r) !== EMPTY) continue;
                    const x = c * CELL;
                    const y = r * CELL;
                    // Draw border on sides that touch soil
                    if (grid.get(c - 1, r) === SOIL || grid.get(c - 1, r) === BEDROCK) {
                        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + CELL); ctx.stroke();
                    }
                    if (grid.get(c + 1, r) === SOIL || grid.get(c + 1, r) === BEDROCK) {
                        ctx.beginPath(); ctx.moveTo(x + CELL, y); ctx.lineTo(x + CELL, y + CELL); ctx.stroke();
                    }
                    if (grid.get(c, r - 1) === SOIL) {
                        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + CELL, y); ctx.stroke();
                    }
                    if (grid.get(c, r + 1) === SOIL || grid.get(c, r + 1) === BEDROCK) {
                        ctx.beginPath(); ctx.moveTo(x, y + CELL); ctx.lineTo(x + CELL, y + CELL); ctx.stroke();
                    }
                }
            }
        },

        _drawEggs(ctx, grid) {
            for (const egg of this.colony.eggs) {
                const x = egg.col * CELL + CELL / 2;
                const y = egg.row * CELL + CELL / 2;
                const stage = egg.stage;

                if (stage === 'egg') {
                    // 알: 작고 하얀 타원
                    ctx.fillStyle = `rgba(245, 240, 220, ${0.7 + egg.progress * 0.3})`;
                    ctx.beginPath();
                    ctx.ellipse(x, y, CELL * 0.35, CELL * 0.25, 0, 0, Math.PI * 2);
                    ctx.fill();
                } else if (stage === 'larva') {
                    // 유충: 약간 더 크고 크림색, 구부러진 형태
                    ctx.fillStyle = `rgba(255, 245, 200, 0.85)`;
                    ctx.beginPath();
                    ctx.ellipse(x, y, CELL * 0.45, CELL * 0.3, 0.2, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.fillStyle = 'rgba(230, 210, 170, 0.5)';
                    ctx.beginPath();
                    ctx.arc(x + 0.5, y - 0.5, CELL * 0.15, 0, Math.PI * 2);
                    ctx.fill();
                } else {
                    // 번데기: 갈색빛, 거의 개미 형태
                    ctx.fillStyle = `rgba(200, 175, 140, 0.9)`;
                    ctx.beginPath();
                    ctx.ellipse(x, y, CELL * 0.4, CELL * 0.28, 0, 0, Math.PI * 2);
                    ctx.fill();
                    // 부화 임박 표시
                    ctx.strokeStyle = `rgba(255, 200, 100, ${(egg.progress - 0.66) * 3})`;
                    ctx.lineWidth = 0.5;
                    ctx.beginPath();
                    ctx.arc(x, y, CELL * 0.55, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }
        },

        _drawFoods(ctx, time) {
            for (const f of this.foods) {
                const pulse = 1 + Math.sin(time * 0.003 + f.phase) * 0.15;
                const r = (3 + (f.amount / 8) * 4) * pulse;

                // Glow
                ctx.fillStyle = 'rgba(126, 207, 92, 0.15)';
                ctx.beginPath();
                ctx.arc(f.x, f.y, r * 2, 0, Math.PI * 2);
                ctx.fill();

                // Body
                const ratio = f.amount / 8;
                ctx.fillStyle = `rgba(126, 207, 92, ${0.5 + ratio * 0.5})`;
                ctx.beginPath();
                ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
                ctx.fill();

                // Leaf shape
                ctx.fillStyle = `rgba(100, 180, 70, ${0.4 + ratio * 0.3})`;
                ctx.beginPath();
                ctx.ellipse(f.x, f.y, r * 0.7, r * 0.4, 0.3, 0, Math.PI * 2);
                ctx.fill();
            }
        },

        _drawAnt(ctx, ant, color, carrying, time, isQueen = false, scale = 1) {
            const x = ant.x;
            const y = ant.y;
            const s = (isQueen ? 1.6 : 1) * scale;
            const flip = ant.facingRight ? 1 : -1;
            const legAnim = Math.sin(ant.walkFrame * 3) * 0.8;

            ctx.save();
            ctx.translate(x, y);
            ctx.scale(flip, 1);

            // Body shadow
            ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
            ctx.beginPath();
            ctx.ellipse(0, 1, 3 * s, 1.5 * s, 0, 0, Math.PI * 2);
            ctx.fill();

            // Abdomen
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.ellipse(-2 * s, 0, 2.5 * s, 1.8 * s, 0, 0, Math.PI * 2);
            ctx.fill();

            // Thorax
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.ellipse(0.5 * s, 0, 1.5 * s, 1.2 * s, 0, 0, Math.PI * 2);
            ctx.fill();

            // Head
            ctx.fillStyle = isQueen ? '#b05528' : '#a08060';
            ctx.beginPath();
            ctx.ellipse(2.5 * s, 0, 1.3 * s, 1 * s, 0, 0, Math.PI * 2);
            ctx.fill();

            // Eyes
            ctx.fillStyle = '#222';
            ctx.beginPath();
            ctx.arc(3 * s, -0.5 * s, 0.3 * s, 0, Math.PI * 2);
            ctx.fill();

            // Legs
            ctx.strokeStyle = 'rgba(120, 90, 60, 0.6)';
            ctx.lineWidth = 0.5;
            for (let i = -1; i <= 1; i++) {
                const lx = i * 1.5 * s;
                const la = legAnim * (i === 0 ? -1 : 1);
                // Top legs
                ctx.beginPath();
                ctx.moveTo(lx, -0.5 * s);
                ctx.lineTo(lx + Math.sin(la) * 2 * s, -2.5 * s);
                ctx.stroke();
                // Bottom legs
                ctx.beginPath();
                ctx.moveTo(lx, 0.5 * s);
                ctx.lineTo(lx + Math.sin(-la) * 2 * s, 2.5 * s);
                ctx.stroke();
            }

            // Antennae
            ctx.strokeStyle = 'rgba(120, 90, 60, 0.7)';
            ctx.lineWidth = 0.4;
            const aw = Math.sin(time * 0.004) * 0.5;
            ctx.beginPath();
            ctx.moveTo(3 * s, -0.8 * s);
            ctx.quadraticCurveTo(4 * s, -2.5 * s + aw, 5 * s, -2.5 * s + aw);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(3 * s, 0.8 * s);
            ctx.quadraticCurveTo(4 * s, 2.5 * s - aw, 5 * s, 2.5 * s - aw);
            ctx.stroke();

            // Queen crown + wings
            if (isQueen) {
                ctx.fillStyle = 'rgba(255, 215, 0, 0.8)';
                ctx.font = `${6 * s}px serif`;
                ctx.fillText('♛', -3 * s, -4 * s);

                // 날개 (탈시 전에만 표시)
                if (ant.hasWings) {
                    ctx.strokeStyle = 'rgba(200, 220, 255, 0.5)';
                    ctx.fillStyle = 'rgba(200, 220, 255, 0.15)';
                    ctx.lineWidth = 0.4;
                    // 왼쪽 날개
                    ctx.beginPath();
                    ctx.ellipse(-1 * s, -3 * s, 4 * s, 1.5 * s, -0.3, 0, Math.PI * 2);
                    ctx.fill(); ctx.stroke();
                    // 오른쪽 날개
                    ctx.beginPath();
                    ctx.ellipse(-1 * s, 3 * s, 4 * s, 1.5 * s, 0.3, 0, Math.PI * 2);
                    ctx.fill(); ctx.stroke();
                }
            }

            // Carrying food/egg
            if (carrying) {
                if (carrying.stage) {
                    // Egg/Larva
                    ctx.fillStyle = '#fffff0';
                    ctx.beginPath();
                    ctx.ellipse(3.5 * s, 0, 1.2 * s, 0.8 * s, 0, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = '#e0e0e0';
                    ctx.lineWidth = 0.5;
                    ctx.stroke();
                } else {
                    // Food
                    ctx.fillStyle = '#7ecf5c';
                    ctx.beginPath();
                    ctx.arc(3.5 * s, 0, 1.2 * s, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            // Digging Action Jitter
            if (ant.state === W_STATE.DIG_ACTION) {
                // 진동 효과
                const jitterX = (Math.random() - 0.5) * 1.5;
                const jitterY = (Math.random() - 0.5) * 1.5;
                ctx.translate(jitterX, jitterY);

                // 파티클 (흙먼지)
                if (Math.random() < 0.3) {
                    ctx.fillStyle = 'rgba(100, 80, 50, 0.7)';
                    ctx.beginPath();
                    ctx.arc(4 * s, rand(-2, 2) * s, rand(1, 2), 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            // Sleep Zzz
            if (ant.state === W_STATE.SLEEPING) {
                const zAlpha = 0.5 + Math.sin(time * 0.005) * 0.4;
                ctx.fillStyle = '#ffffff';
                ctx.globalAlpha = zAlpha;
                ctx.textAlign = 'center';
                ctx.font = `${10 * s}px sans-serif`;
                ctx.fillText('Z', 0, -4 * s - (time * 0.05 % 10));
                ctx.font = `${7 * s}px sans-serif`;
                ctx.fillText('z', 5 * s, -6 * s - ((time * 0.05 + 5) % 10));
                ctx.globalAlpha = 1.0;
                ctx.textAlign = 'start';
            }

            // Digging particles
            if (ant.digging) {
                ctx.fillStyle = 'rgba(120, 90, 50, 0.6)';
                for (let i = 0; i < 3; i++) {
                    ctx.beginPath();
                    ctx.arc(
                        4 * s + rand(-3, 3),
                        rand(-3, 3),
                        rand(0.5, 1.5),
                        0, Math.PI * 2
                    );
                    ctx.fill();
                }
            }

            ctx.restore();
        },

        // ─── HUD ───
        _updateHUD() {
            // 카스트별 카운트
            const counts = { forager: 0, digger: 0, nurse: 0, guard: 0, male: 0 };
            for (const w of this.workers) counts[w.caste]++;
            const breakdown = `${this.workers.length} (채${counts.forager}/굴${counts.digger}/육${counts.nurse}/경${counts.guard}/♂${counts.male})`;
            document.getElementById('stat-workers').textContent = breakdown;
            document.getElementById('stat-eggs').textContent = this.colony.eggs.length;
            document.getElementById('stat-food').textContent = Math.floor(this.colony.food) + (this.colony.foodChamber ? ' 📦' : '');
            document.getElementById('stat-tunnels').textContent = this.grid.countEmpty();

            // 여왕 단계 & 체내 에너지
            document.getElementById('stat-phase').textContent = this.queen.colonyPhase;
            const energyPct = Math.max(0, Math.round((this.queen.wingEnergy / QUEEN_WING_ENERGY) * 100));
            document.getElementById('stat-energy').textContent = energyPct + '%';

            const totalSec = Math.floor(this.elapsed / 1000);
            const min = Math.floor(totalSec / 60);
            const sec = totalSec % 60;
            document.getElementById('stat-time').textContent = `${min}:${sec.toString().padStart(2, '0')}`;
        },

        _toggleBGM() {
            const btn = document.getElementById('btn-bgm');
            // Cycle modes: 0(OFF) -> 1(Happy) -> 2(Cafe) -> 3(Dark) -> 0
            const nextMode = (this.bgm.mode + 1) % 4;
            this.bgm.setMode(nextMode);

            const labels = ['🎵 OFF', '😊 Happy', '☕ Cafe', '🌑 Dark'];
            btn.textContent = labels[nextMode];

            if (nextMode === 0) btn.classList.remove('active');
            else btn.classList.add('active');
        }
    };

    window.addEventListener('DOMContentLoaded', () => {
        const startScreen = document.getElementById('start-screen');
        const buttons = document.querySelectorAll('.btn-size');

        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                const size = btn.dataset.size;
                const container = document.getElementById('farm-frame');

                // Reset classes
                container.classList.remove('map-size-small', 'map-size-medium', 'map-size-large');

                // Map size logic:
                // Apply CSS class to resize the container
                // CELL size remains constant (4) so that smaller container = fewer cells
                CELL = 4;

                if (size === 'small') {
                    container.classList.add('map-size-small');
                }
                else if (size === 'medium') {
                    container.classList.add('map-size-medium');
                }
                else if (size === 'large') {
                    container.classList.add('map-size-large');
                }

                // Resume audio context
                if (game.bgm && game.bgm.ctx) {
                    game.bgm.ctx.resume();
                }

                startScreen.classList.add('hidden');
                setTimeout(() => {
                    startScreen.style.display = 'none';
                    game.init();
                }, 500);
            });
        });
    });
})();
