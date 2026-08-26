# Vibratus PolyMAX 核心代码（v2.0.3）

## 调用链

```text
ModalAnalysisViewModel.RunPolymaxAsync
  -> Polymax.Run                    p-LSCF 阶次扫描、公共分母、极点、参与向量
  -> StabilityAnalyzer.Classify    f / d / vector 跨阶稳定判据
  -> StabilityAnalyzer.Cluster     DBSCAN + 碎片簇合并
  -> LsfdEstimator.Estimate        复留数、共轭极点、LR/UR
  -> ModalSynthesis.Evaluate       综合 FRF、相关性、误差、模态贡献
  -> 低贡献候选剔除
  -> 最终 LSFD 重拟合与振型显示
```

## 核心数学模型

p-LSCF 单参考多输出模型：

```text
H_o(z) * A(z) ~= B_o(z)
A(z) = sum(alpha_k * z^k)
B_o(z) = sum(beta_o,k * z^k)
```

每个输出构造实系数正规方程：

```text
R_o = Re(X^H X)
S_o = Re(-X^H Y_o)
T_o = Re(Y_o^H Y_o)
M   = sum_o(T_o - S_o^T R_o^-1 S_o)
beta_o = -R_o^-1 S_o alpha
```

根映射到连续极点：

```text
p = -log(z) / dt
fn = |p| / (2*pi)
zeta = -Re(p) / |p|
```

参与向量由各输出分子在极点处求值得到：

```text
v_p[o] = B_o(z_p)
```

LSFD 综合模型：

```text
Hhat_o(jw) = sum_k[
    r_k,o/(jw-p_k) + conj(r_k,o)/(jw-conj(p_k))
] - LR_o/w^2 + UR_o
```

拟合质量：

```text
correlation = |sum(conj(H)*Hhat)| / sqrt(sum(|H|^2)*sum(|Hhat|^2))
relativeError = sqrt(sum(|H-Hhat|^2) / sum(|H|^2))
```

## 窄带病态告警（NarrowBandWarning）

`Polymax.Run` 返回的 `PolymaxResult` 携带两个诊断字段：

- `BasisArcLength`：识别频带在 z 域单位圆上扫过的弧长 `(ω_max − ω_min) * dt`（弧度）。
- `NarrowBandWarning`：`BasisArcLength < 0.5` 时为 `true`。

p-LSCF 的基函数 `z^k = e^(−jkω·dt)` 只在单位圆上该弧段内取值。当识别频带相对
采样带宽过窄（弧长过短）时，各阶基函数几乎线性相关，正规方程严重病态（cond(R) 可达
10¹⁷ 量级），求得的极点频率和阻尼可信度低，且 PolyMAX 标志性的“干净稳定图”特性也会失效。
出现该告警时应扩大识别频带（PolyFreqMin/Max），或改用更贴近识别频带的采样/细化设置后复核稳定图。

## 文件说明

- `Dsp/Polymax.cs`：PolyMAX/p-LSCF 核心求解器。
- `Dsp/StabilityAnalyzer.cs`：稳定图、参与向量 MAC、DBSCAN、碎片合并。
- `Dsp/LsfdEstimator.cs`：最终复留数、实/复振型、LR/UR。
- `Dsp/ModalSynthesis.cs`：综合 FRF、相关性、相对误差、各模态贡献率。
- `ViewModels/ModalAnalysisViewModel.Polymax.cs`：软件内完整自动识别和手动增删重拟合流程。
- `tests/NiScope.Tests/*`：数值回归、近频模态、稳定聚类与综合拟合测试。

## 当前范围

当前 FRF 数据结构为单参考、多响应（SIMO）。多参考 MIMO 需把 FRF 扩展为
`H[frequency, response, reference]`，并同步修改 QSV 导入、RMFD 矩阵方程及 LSFD。
