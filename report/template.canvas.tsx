import { BarChart, Callout, Grid, H1, H2, Stack, Stat, Table, Text } from "cursor/canvas";

// Replace this object with the run's evidence.json. Keep example:false for a real run.
const EVIDENCE = {
  example: true,
  game: { title: "SlotLifeOfPets", urlPath: "/game/slot/SlotLifeOfPets/" },
  conditions: {
    viewport: { w: 1280, h: 720, dpr: 1 },
    gpu: "NVIDIA GeForce GTX 1050 Ti",
    engine: "2.0.9",
    webgl: "WebGL 1.0",
    webdriver: true,
  },
  stages: [
    { name: "idle", fps: 61.2, cpuMs: { avg: 2.11, p95: 2.8, max: 3.4 }, gpuMs: { avg: 4.15, p95: 6.85, max: 7.77 }, cpuPct: 12.9, gpuPct: 24.9, draws: { avg: 51.9, max: 55 }, hitches: [] },
    { name: "spin-1", fps: 58.4, cpuMs: { avg: 4.18, p95: 5.4, max: 210.4 }, gpuMs: { avg: 3.75, p95: 7.01, max: 7.38 }, cpuPct: 24.4, gpuPct: 22.5, draws: { avg: 71, max: 82 }, hitches: [{ dt: 210.8 }] },
    { name: "turbo-1", fps: 58.9, cpuMs: { avg: 2.72, p95: 2.5, max: 114.4 }, gpuMs: { avg: 4.58, p95: 7.36, max: 8.37 }, cpuPct: 16, gpuPct: 27.4, draws: { avg: 71.6, max: 93 }, hitches: [{ dt: 115 }] },
  ],
  memory: { textures: { status: "ok", mb: 270.2, count: 171 } },
  findings: [
    { id: "texture-heavy", stage: "idle", detail: "171 張 RGBA8888，駐留 270.2 MB。" },
    { id: "hitch-other", stage: "spin-1", detail: "210.8 ms 的一幀，CPU 210.4 ms，GPU 7.38 ms。" },
  ],
  coverage: { spins: 2, loading: false, history: 0, rules: false, notes: ["短測範例，不是完整定錨。"] },
};

function num(value: number | null | undefined, digits = 1) {
  return value == null ? "—" : value.toFixed(digits);
}

export default function SlotPagePerfReport() {
  const stages = EVIDENCE.stages;
  const idle = stages.find((stage) => stage.name === "idle");
  const spins = stages.filter((stage) => stage.name.startsWith("spin-") || stage.name.startsWith("turbo-"));
  const spinFps = spins.length ? spins.reduce((sum, stage) => sum + (stage.fps || 0), 0) / spins.length : null;
  const loading = stages.find((stage) => stage.name === "loading");
  const textureMb = EVIDENCE.memory.textures.status === "ok" ? EVIDENCE.memory.textures.mb : null;
  const names = stages.map((stage) => stage.name);

  return (
    <Stack gap={20}>
      <Stack gap={6}>
        <H1>{EVIDENCE.example ? "範例 · " : ""}{EVIDENCE.game.title}</H1>
        <Text tone="secondary">
          {EVIDENCE.conditions.viewport.w}×{EVIDENCE.conditions.viewport.h} · DPR {EVIDENCE.conditions.viewport.dpr} · {EVIDENCE.conditions.engine} · {EVIDENCE.conditions.webgl}
        </Text>
        <Text tone="tertiary" size="small">
          {EVIDENCE.conditions.gpu} · 自動化瀏覽器 {EVIDENCE.conditions.webdriver ? "是" : "否"} · {EVIDENCE.game.urlPath}
        </Text>
      </Stack>

      <Callout tone="info" title="CPU% 與 GPU% 是幀預算占比">
        CPU% 是主執行緒忙碌時間除以該階段的幀間隔合計。GPU% 是 GPU timer 除以 16.7 ms。兩條都不是工作管理員的整機使用率。
      </Callout>

      <Grid columns={4} gap={16}>
        <Stat value={num(idle?.fps, 0)} label="待機 FPS" />
        <Stat value={num(spinFps, 0)} label="旋轉 FPS（平均）" />
        <Stat value={loading ? `${num(loading.cpuPct, 0)}%` : "未錄到"} label="Loading CPU%" />
        <Stat value={textureMb == null ? "未讀到" : `${textureMb} MB`} label="貼圖駐留" />
      </Grid>

      <H2>各階段 FPS</H2>
      <BarChart
        categories={names}
        series={[{ name: "平均 FPS", data: stages.map((stage) => stage.fps || 0), tone: "info" }]}
        referenceLines={[{ value: 60, label: "60 FPS", tone: "success" }]}
        yMax={70}
        height={220}
        showValues
      />
      <Text tone="tertiary" size="small">平均 FPS，依 evidence.stages 的順序。來源是這次定錨的 evidence.json。</Text>

      <H2>主執行緒與 GPU 時間</H2>
      <BarChart
        categories={names}
        series={[
          { name: "CPU 平均 (ms)", data: stages.map((stage) => stage.cpuMs?.avg || 0), tone: "warning" },
          { name: "GPU 平均 (ms)", data: stages.map((stage) => stage.gpuMs?.avg || 0), tone: "info" },
        ]}
        referenceLines={[{ value: 16.7, label: "16.7 ms", tone: "danger" }]}
        valueSuffix=" ms"
        height={240}
        showValues
      />

      <H2>CPU% 與 GPU%</H2>
      <BarChart
        categories={names}
        series={[
          { name: "CPU%", data: stages.map((stage) => stage.cpuPct || 0), tone: "warning" },
          { name: "GPU%", data: stages.map((stage) => stage.gpuPct || 0), tone: "info" },
        ]}
        valueSuffix="%"
        yMax={100}
        height={220}
        showValues
      />
      <Text tone="tertiary" size="small">CPU% = 主執行緒時間 ÷ 幀間隔。GPU% = GPU timer ÷ 16.7 ms。沒有 timer 的階段應從 evidence 省略，不要補 0。</Text>

      <H2>問題</H2>
      <Table
        headers={["規則", "階段", "證據"]}
        rows={EVIDENCE.findings.map((finding) => [finding.id, finding.stage, finding.detail])}
        striped
      />
      <Text tone="secondary">{EVIDENCE.coverage.notes.join(" ")}</Text>
    </Stack>
  );
}
