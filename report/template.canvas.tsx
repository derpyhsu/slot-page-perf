import { CollapsibleSection, Divider, Grid, H1, H2, Pill, Row, Stack, Table, Text, useHostTheme, useState } from "cursor/canvas";

// report/canvas.js replaces everything between the EVIDENCE markers with a run's evidence.json.
/* EVIDENCE:BEGIN */
const EVIDENCE: Evidence = {
  example: true,
  game: { title: "範例", urlPath: "/game/slot/Example/" },
  conditions: { viewport: { w: 1280, h: 720, dpr: 1 }, engine: "3.8.2", gpu: "example" },
  channels: { engineCpu: false, gpuTimer: false },
  stages: [],
  memory: {},
  summary: { smooth: "用 report/canvas.js 換上這次的 evidence。", memory: "" },
  issues: [],
};
/* EVIDENCE:END */

type Hitch = { t?: number | null; dt: number; source?: string };
type StageRow = {
  name: string;
  startMs?: number;
  wallMs: number;
  frames: number;
  fps: number | null;
  cpuMs?: { avg: number; p95: number; max: number } | null;
  draws?: { avg: number } | null;
  hitches?: Hitch[];
  heapStartMb?: number | null;
  heapEndMb?: number | null;
};
type ScoreItem = { id: string; label: string; weight: number; value: number | null; unit: string; full: string; zero: string; score: number | null; approx?: boolean };
type ScorePart = { score: number | null; coverage: number; provisional: boolean; items: ScoreItem[]; fatal: Array<{ id: string; stage?: string; value?: number }>; budgetMb?: number; estimateMb?: { heap: number; texture: number; framebuffer: number; total: number } | null };
type Issue = { title: string; stage?: string; t?: number | null; next: string; level?: string; area?: string; rule?: string };
type TodoRow = { n: number; level: string; title: string; area: string; fix: string; stage: string | null; t: number | null; rule?: string };
type Evidence = {
  example?: boolean;
  game: { title: string; displayName?: string; urlPath: string };
  conditions: { viewport: { w: number; h: number; dpr: number }; engine?: string; gpu?: string; capturedAt?: string };
  channels: { engineCpu?: boolean; gpuTimer?: boolean };
  stages: StageRow[];
  memory: { textures?: { status: string; mb: number; count: number } };
  timeline?: { bucketMs: number; buckets: number[][]; longTasks: number[][]; marks: Array<[string, number]>; heap: number[][]; textures: number[][] };
  score?: { smooth: ScorePart; memory: ScorePart };
  summary?: { smooth?: string; memory?: string };
  issues?: Issue[];
  todo?: TodoRow[];
  missing?: string[];
  cocosAdvice?: {
    status: string;
    items: Array<{ id: string; level?: string; area: string; title: string; fix: string }>;
    scene: { nodes: number | null; activeNodes: number | null; spine: number | null; spineActive: number | null; spineRealtime: number | null; labels: number | null; masks: number | null; particles: number | null } | null;
  };
};

function CocosFacts({ ev }: { ev: Evidence }) {
  const advice = ev.cocosAdvice;
  if (!advice) return null;
  const scene = advice.scene;
  const facts: Array<[string, number | null]> = scene
    ? [
        ["節點", scene.nodes],
        ["顯示中的節點", scene.activeNodes],
        ["Spine", scene.spine],
        ["在畫的 Spine", scene.spineActive],
        ["其中即時運算", scene.spineRealtime],
        ["Label", scene.labels],
        ["Mask", scene.masks],
        ["粒子系統", scene.particles],
      ]
    : [];
  const shown = facts.filter(([, v]) => v != null);
  return (
    <Stack gap={8}>
      <Text weight="semibold">Cocos 場景</Text>
      {shown.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
          {shown.map(([k, v]) => (
            <Stack key={k} gap={0}>
              <Text weight="semibold">{String(v)}</Text>
              <Text size="small" tone="tertiary">
                {k}
              </Text>
            </Stack>
          ))}
        </div>
      )}
      {advice.status !== "ok" && (
        <Text size="small" tone="tertiary">
          {advice.status === "textures-only" ? "這次只讀到貼圖，沒有走場景。" : "這次沒有讀場景。"}
        </Text>
      )}
      {advice.status === "ok" && !advice.items.length && <Text size="small" tone="secondary">組成和引擎設定都在門檻內。</Text>}
    </Stack>
  );
}

function TodoTable({ rows }: { rows: TodoRow[] }) {
  return (
    <Table
      headers={["#", "", "問題", "類別", "怎麼改"]}
      columnAlign={["right", "left", "left", "left", "left"]}
      rows={rows.map((r) => [String(r.n), <Dot key="d" level={asLevel(r.level)} />, r.title, r.area, r.fix])}
    />
  );
}

type Level = "green" | "yellow" | "orange" | "red";

const STAGE_NAMES: Record<string, string> = {
  boot: "開機",
  loading: "載入",
  splash: "開始畫面",
  enter: "進遊戲",
  idle: "待機",
  menu: "功能列表",
  "history-before-spike": "下注紀錄",
  "history-before": "下注紀錄",
  "rules-spike": "遊戲規則",
  rules: "遊戲規則",
  "idle-after-rules": "規則後待機",
  "history-after-spike": "轉後下注紀錄",
  "history-after": "轉後下注紀錄",
};

function groupName(name: string) {
  if (/^spin-\d+$/.test(name)) return "一般旋轉";
  if (/^turbo-\d+$/.test(name)) return "加速旋轉";
  if (name.startsWith("scene:")) return name.slice(6);
  return STAGE_NAMES[name] ?? name;
}

function scoreLevel(score: number | null): Level {
  if (score == null) return "yellow";
  return score >= 90 ? "green" : score >= 70 ? "yellow" : score >= 50 ? "orange" : "red";
}

function stallLevel(ms: number): Level {
  return ms <= 50 ? "green" : ms <= 100 ? "yellow" : ms <= 200 ? "orange" : "red";
}

function asLevel(v: string | undefined): Level {
  return v === "red" || v === "orange" || v === "yellow" || v === "green" ? v : "red";
}

function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Stage start times. New probes write startMs; older runs are laid end to end from wallMs.
function placedStages(ev: Evidence) {
  let t = 0;
  return ev.stages
    .filter((s) => s.name !== "gap")
    .map((s) => {
      const start = s.startMs ?? t;
      t = start + s.wallMs;
      return { ...s, start, end: start + s.wallMs };
    });
}

function ScoreRing({ title, part, sentence }: { title: string; part: ScorePart | undefined; sentence?: string }) {
  const theme = useHostTheme();
  const score = part?.score ?? null;
  const level = scoreLevel(score);
  const r = 46;
  const c = 2 * Math.PI * r;
  const shown = score == null ? 0 : score / 100;
  const missing = part ? (100 - part.coverage) / 100 : 1;
  return (
    <Row gap={20} align="center">
      <svg width={120} height={120} viewBox="0 0 120 120">
        <circle cx={60} cy={60} r={r} fill="none" stroke={theme.fill.secondary} strokeWidth={10} />
        {missing > 0 && (
          <circle cx={60} cy={60} r={r} fill="none" stroke={theme.stroke.secondary} strokeWidth={10} strokeDasharray={`${c * missing} ${c}`} strokeDashoffset={-c * (1 - missing)} transform="rotate(-90 60 60)" />
        )}
        <circle cx={60} cy={60} r={r} fill="none" stroke={theme.category[level]} strokeWidth={10} strokeDasharray={`${c * shown * (1 - missing)} ${c}`} transform="rotate(-90 60 60)" />
        <text x={60} y={66} textAnchor="middle" fontSize={30} fontWeight={600} fill={theme.category[level]}>
          {score == null ? "—" : score}
        </text>
      </svg>
      <Stack gap={4}>
        <Text weight="semibold">{title}</Text>
        {sentence && <Text>{sentence}</Text>}
        {part?.provisional && (
          <Text size="small" tone="tertiary">
            暫定，量到 {part.coverage}%。灰色那段這次沒量到。
          </Text>
        )}
      </Stack>
    </Row>
  );
}

function stageGroups(ev: Evidence) {
  const groups: Array<{ name: string; start: number; end: number }> = [];
  placedStages(ev).forEach((s) => {
    if (s.name === "boot" || s.name === "game-ready") return;
    const name = groupName(s.name);
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.end = s.end;
    else groups.push({ name, start: s.start, end: s.end });
  });
  return groups;
}

function Timeline({ ev, range }: { ev: Evidence; range: [number, number] | null }) {
  const theme = useHostTheme();
  const placed = placedStages(ev);
  if (!placed.length) return null;
  const fullMs = Math.max(...placed.map((s) => s.end));
  const [from, to] = range ?? [0, fullMs];
  const span = Math.max(1, to - from);
  const W = 1000;
  const L = 74;
  const X = (ms: number) => L + ((W - L - 8) * (Math.max(from, Math.min(to, ms)) - from)) / span;
  const fine = !!ev.timeline && ev.timeline.buckets.length > 0;
  const engineCpu = !!ev.channels.engineCpu;
  const groups = stageGroups(ev).filter((g) => g.end > from && g.start < to);

  const stalls: Array<{ start: number; end: number; dt: number; exact: boolean }> = [];
  const visible = (s: { start: number; end: number }) => s.end >= from && s.start <= to;
  if (fine) {
    ev.timeline!.longTasks.forEach((lt) => stalls.push({ start: lt[0], end: lt[0] + lt[1], dt: lt[1], exact: true }));
    ev.timeline!.buckets.forEach((b) => {
      if (b[2] > 50) stalls.push({ start: b[0], end: b[0] + ev.timeline!.bucketMs, dt: b[2], exact: true });
    });
  } else {
    placed.forEach((s) => (s.hitches ?? []).forEach((h) => stalls.push({ start: s.start, end: s.end, dt: h.dt, exact: h.t != null })));
  }

  const cpuPath = (() => {
    if (!fine || !engineCpu) return null;
    const bm = ev.timeline!.bucketMs;
    const pts = ev.timeline!.buckets.map((b) => [X(b[0] + bm / 2), Math.min(1, (b[3] ?? 0) / bm)]);
    return `M${X(from)},86 ` + pts.map(([x, v]) => `L${x.toFixed(1)},${(86 - v * 40).toFixed(1)}`).join(" ") + ` L${X(to)},86 Z`;
  })();

  const heapPts: Array<[number, number]> = fine && ev.timeline!.heap.length
    ? ev.timeline!.heap.map((p) => [p[0], p[1]] as [number, number])
    : placed.flatMap((s) => [s.heapStartMb != null ? ([s.start, s.heapStartMb] as [number, number]) : null, s.heapEndMb != null ? ([s.end, s.heapEndMb] as [number, number]) : null]).filter((p): p is [number, number] => p != null);
  const texFinal = ev.memory.textures?.status === "ok" ? ev.memory.textures.mb : null;
  const readyAt = placed.find((s) => s.name === "game-ready")?.start ?? placed.find((s) => s.name === "idle")?.start ?? 0;
  const texAt = (ms: number) => {
    if (fine && ev.timeline!.textures.length) {
      const before = ev.timeline!.textures.filter((p) => p[0] <= ms);
      return before.length ? before[before.length - 1][1] : 0;
    }
    return texFinal != null && ms >= readyAt ? texFinal : 0;
  };
  const budget = ev.score?.memory.budgetMb ?? 300;
  const memMax = Math.max(budget, ...heapPts.map(([t, v]) => v + texAt(t))) * 1.05;
  const MY = (mb: number) => 196 - (mb / memMax) * 50;
  const line = (pts: Array<[number, number]>) => pts.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${MY(v).toFixed(1)}`).join(" ");

  const issueMarks = (ev.todo ?? [])
    .map((row) => {
      const st = placed.find((s) => s.name === row.stage);
      const at = row.t ?? (st ? (st.start + st.end) / 2 : undefined);
      return at == null || at < from || at > to ? null : { n: row.n, x: X(at) };
    })
    .filter((m): m is { n: number; x: number } => m != null);

  const tickMs = [5000, 10000, 30000, 60000, 120000].find((t) => span / t <= 10) ?? 300000;
  const minutes = Array.from({ length: Math.floor(span / tickMs) + 2 }, (_, i) => Math.ceil(from / tickMs) * tickMs + i * tickMs).filter((m) => m <= to);
  const label = (y: number, text: string) => (
    <text x={0} y={y} fontSize={12} fill={theme.text.secondary}>
      {text}
    </text>
  );

  return (
    <svg width="100%" viewBox={`0 0 ${W} 222`} style={{ display: "block" }}>
      <defs>
        <pattern id="unmeasured" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={6} height={6} fill={theme.fill.quaternary} />
          <line x1={0} y1={0} x2={0} y2={6} stroke={theme.stroke.secondary} strokeWidth={2} />
        </pattern>
      </defs>

      {label(22, "階段")}
      {groups.map((g, i) => (
        <g key={`${g.name}-${i}`}>
          <rect x={X(g.start)} y={8} width={Math.max(1, X(g.end) - X(g.start))} height={22} fill={i % 2 ? theme.fill.secondary : theme.fill.tertiary} />
          {X(g.end) - X(g.start) > 46 && (
            <text x={X(g.start) + 4} y={23} fontSize={11} fill={theme.text.primary}>
              {g.name}
            </text>
          )}
        </g>
      ))}

      {label(70, "CPU")}
      {cpuPath ? (
        <path d={cpuPath} fill={theme.category.yellow} opacity={0.85} />
      ) : (
        <>
          <rect x={L} y={46} width={W - L - 8} height={40} fill="url(#unmeasured)" />
          <text x={(L + W) / 2} y={70} textAnchor="middle" fontSize={12} fill={theme.text.secondary}>
            這次沒量到每幀 CPU
          </text>
        </>
      )}

      {label(118, "卡頓")}
      <rect x={L} y={100} width={W - L - 8} height={28} fill={theme.fill.quaternary} />
      {stalls.filter(visible).map((s, i) =>
        s.exact ? (
          <rect key={i} x={X(s.start)} y={100} width={Math.max(3, X(s.end) - X(s.start))} height={28} fill={theme.category[stallLevel(s.dt)]} />
        ) : (
          <rect key={i} x={X(s.start)} y={100} width={Math.max(3, X(s.end) - X(s.start))} height={28} fill={theme.category[stallLevel(s.dt)]} opacity={0.35} />
        ),
      )}
      {issueMarks.map((m) => (
        <g key={m.n}>
          <circle cx={m.x} cy={96} r={8} fill={theme.text.primary} />
          <text x={m.x} y={100} textAnchor="middle" fontSize={11} fontWeight={600} fill={theme.bg.editor}>
            {m.n}
          </text>
        </g>
      ))}

      {label(166, "記憶體")}
      <line x1={L} x2={W - 8} y1={MY(budget)} y2={MY(budget)} stroke={theme.category.red} strokeDasharray="4 4" />
      <text x={W - 10} y={MY(budget) - 4} textAnchor="end" fontSize={11} fill={theme.category.red}>
        預算 {budget} MB
      </text>
      {heapPts.length > 1 && (
        <>
          <path d={line(heapPts.map(([t, v]) => [t, v + texAt(t)]))} fill="none" stroke={theme.category.purple} strokeWidth={2} />
          <path d={line(heapPts)} fill="none" stroke={theme.category.blue} strokeWidth={2} />
        </>
      )}

      {minutes.map((m) => (
        <text key={m} x={X(m)} y={216} fontSize={11} fill={theme.text.tertiary} textAnchor="middle">
          {clock(m)}
        </text>
      ))}
    </svg>
  );
}

function Legend({ fine }: { fine: boolean }) {
  const theme = useHostTheme();
  const items: Array<[string, string]> = [
    [theme.category.yellow, "CPU 忙碌"],
    [theme.category.red, "停超過 200 ms"],
    [theme.category.orange, "100–200 ms"],
    [theme.category.yellow, "50–100 ms"],
    [theme.category.blue, "JS heap"],
    [theme.category.purple, "JS heap＋貼圖"],
  ];
  return (
    <Stack gap={4}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        {items.map(([color, text]) => (
          <div key={text} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 10, height: 10, background: color }} />
            <Text size="small" tone="secondary" as="span">
              {text}
            </Text>
          </div>
        ))}
      </div>
      {!fine && (
        <Text size="small" tone="tertiary">
          這次的資料只有每個階段的彙總。淡色紅塊代表停頓發生在那個階段裡，確切時間點要用新版探針重跑。
        </Text>
      )}
    </Stack>
  );
}

function Dot({ level }: { level: Level }) {
  const theme = useHostTheme();
  return <div style={{ width: 10, height: 10, borderRadius: 5, background: theme.category[level], flexShrink: 0, marginTop: 6 }} />;
}

function CurrentState({ ev }: { ev: Evidence }) {
  const theme = useHostTheme();
  const est = ev.score?.memory.estimateMb;
  const budget = ev.score?.memory.budgetMb ?? 300;
  const cpu = ev.score?.smooth.items.find((i) => i.id === "cpu");
  const growth = ev.score?.memory.items.find((i) => i.id === "growth");
  const bar = (parts: Array<[number, string]>, max: number) => (
    <div style={{ display: "flex", height: 12, background: theme.fill.tertiary, width: "100%" }}>
      {parts.map(([v, color], i) => (
        <div key={i} style={{ width: `${Math.min(100, (100 * v) / max)}%`, background: color }} />
      ))}
    </div>
  );
  return (
    <Grid columns={2} gap={24}>
      <Stack gap={8}>
        <Text weight="semibold">CPU：每一幀遊戲程式花多久</Text>
        {cpu?.value != null ? (
          <>
            {bar([[cpu.value, theme.category.yellow]], 16.7)}
            <Text size="small" tone="secondary">
              最忙的階段，95% 的幀在 {cpu.value} ms 內跑完。一幀的預算是 16.7 ms。
            </Text>
          </>
        ) : (
          <>
            <div style={{ height: 12, background: theme.fill.tertiary }} />
            <Text size="small" tone="secondary">
              這次沒量到。卡頓那一條仍然有效，它來自瀏覽器自己的長任務紀錄。
            </Text>
          </>
        )}
      </Stack>
      <Stack gap={8}>
        <Text weight="semibold">記憶體：離裝置上限多遠</Text>
        {est ? (
          <>
            {bar([[est.heap, theme.category.blue], [est.texture, theme.category.purple], [est.framebuffer, theme.stroke.primary]], budget)}
            <Text size="small" tone="secondary">
              推估最高 {Math.round(est.total)} MB，預算 {budget} MB。JS {Math.round(est.heap)}、貼圖 {Math.round(est.texture)}、畫面 {Math.round(est.framebuffer)}。
              {growth?.value != null ? ` 每轉多留 ${growth.value} MB。` : ""}
            </Text>
          </>
        ) : (
          <Text size="small" tone="secondary">
            這次沒量到。
          </Text>
        )}
      </Stack>
    </Grid>
  );
}

function Criteria({ ev }: { ev: Evidence }) {
  const theme = useHostTheme();
  if (!ev.score) return null;
  const rows = [
    ...ev.score.smooth.items.map((i) => ["順暢", i] as const),
    ...ev.score.memory.items.map((i) => ["記憶體", i] as const),
  ];
  return (
    <Table
      headers={["", "看什麼", "權重", "這次", "滿分", "零分", "得分"]}
      columnAlign={["left", "left", "right", "right", "right", "right", "right"]}
      rows={rows.map(([group, i]) => [
        group,
        i.label,
        String(i.weight),
        i.value == null ? "沒量到" : `${i.approx ? "約 " : ""}${i.value} ${i.unit}`,
        i.full,
        i.zero,
        i.score == null ? (
          "不計"
        ) : (
          <span style={{ color: theme.category[scoreLevel(i.score)], fontWeight: 600 }}>{i.score}</span>
        ),
      ])}
    />
  );
}

export default function SlotPerfReport() {
  const ev = EVIDENCE;
  const fine = !!ev.timeline && ev.timeline.buckets.length > 0;
  const fatal = [...(ev.score?.smooth.fatal ?? []), ...(ev.score?.memory.fatal ?? [])];
  const todo = ev.todo ?? [];
  const placed = placedStages(ev);
  const groups = stageGroups(ev);
  const [zoom, setZoom] = useState<number | null>(null);

  return (
    <Stack gap={28}>
      <Stack gap={4}>
        <H1>{ev.example ? "範例 · " : ""}{ev.game.displayName ?? ev.game.title}</H1>
        <Text size="small" tone="tertiary">
          {ev.conditions.viewport.w}×{ev.conditions.viewport.h} · Cocos {ev.conditions.engine} · {(ev.conditions.capturedAt ?? "").slice(0, 10)} · 目標：穩定 60 FPS，低階裝置不爆記憶體
        </Text>
      </Stack>

      <Grid columns={2} gap={24}>
        <ScoreRing title="順暢" part={ev.score?.smooth} sentence={ev.summary?.smooth} />
        <ScoreRing title="記憶體" part={ev.score?.memory} sentence={ev.summary?.memory} />
      </Grid>
      <Text weight="semibold">{fatal.length ? `致命漏洞 ${fatal.length} 個` : "沒有找到致命漏洞"}</Text>

      <Stack gap={10}>
        <H2>全程</H2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <Pill active={zoom == null} onClick={() => setZoom(null)}>
            全程
          </Pill>
          {groups.map((g, i) => (
            <Pill key={i} active={zoom === i} onClick={() => setZoom(i)}>
              {g.name}
            </Pill>
          ))}
        </div>
        <Timeline ev={ev} range={zoom == null ? null : [groups[zoom].start, groups[zoom].end]} />
        <Legend fine={fine} />
      </Stack>

      {todo.length > 0 && (
        <Stack gap={12}>
          <H2>要處理的地方</H2>
          <TodoTable rows={todo} />
        </Stack>
      )}

      <Stack gap={16}>
        <H2>目前狀況</H2>
        <CurrentState ev={ev} />
        <CocosFacts ev={ev} />
      </Stack>

      <Divider />

      <CollapsibleSection title="分數怎麼算">
        <Stack gap={8}>
          <Text size="small" tone="secondary">
            每項在滿分與零分之間內插。沒量到的項目不計入，分數標暫定。有致命漏洞時該分數最高 49。90 以上綠、70 以上黃、50 以上橘、其餘紅。
          </Text>
          <Criteria ev={ev} />
        </Stack>
      </CollapsibleSection>

      <CollapsibleSection title="各階段數字">
        <Table
          headers={["階段", "開始", "FPS", "CPU p95", "畫的次數", "JS heap", "最長停頓"]}
          columnAlign={["left", "right", "right", "right", "right", "right", "right"]}
          rows={placed
            .filter((s) => s.frames > 0 && !/^(spin|turbo)-\d+$/.test(s.name))
            .map((s) => {
              const worst = Math.max(0, ...(s.hitches ?? []).map((h) => h.dt));
              return [
                `${groupName(s.name)}${s.name.endsWith("-spike") ? "（剛打開）" : ""}`,
                clock(s.start),
                s.fps == null ? "—" : s.fps.toFixed(0),
                ev.channels.engineCpu && s.cpuMs ? `${s.cpuMs.p95} ms` : "沒量到",
                s.draws ? s.draws.avg.toFixed(0) : "—",
                s.heapEndMb != null ? `${s.heapEndMb.toFixed(0)} MB` : "—",
                worst ? `${worst.toFixed(0)} ms` : "",
              ];
            })}
        />
      </CollapsibleSection>

      {(ev.missing ?? []).length > 0 && (
        <Text size="small" tone="tertiary">
          這次沒量到：{(ev.missing ?? []).join("、")}。
        </Text>
      )}
    </Stack>
  );
}
