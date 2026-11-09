# {{title}} 效能定錨

{{conditions}}

{{coverage}}

## 總覽

| 項目 | 值 |
| --- | --- |
| 待機 FPS | {{idleFps}} |
| 旋轉 FPS | {{spinFps}} |
| Loading CPU% | {{loadingCpuPct}} |
| 貼圖駐留 | {{textureMb}} |

CPU% 是該階段主執行緒忙碌時間除以幀間隔的合計。GPU% 是 GPU timer 平均值除以 16.7 ms。兩者都不是工作管理員的整機百分比。

## 各階段

| 階段 | FPS | CPU 平均 / p95 / 最大 | CPU% | GPU 平均 / p95 / 最大 | GPU% | Draw call | 長幀 |
| --- | --- | --- | --- | --- | --- | --- | --- |
{{stageRows}}

## 問題

| 規則 | 階段 | 證據 |
| --- | --- | --- |
{{findingRows}}

沒有列在表上的規則就是這次沒有觸發，或所需探針是 unavailable。
