using System;
using System.Linq;
using System.Numerics;
using System.Threading.Tasks;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using NiScope.Dsp;
using NiScope.Services;

namespace NiScope.ViewModels;

/// <summary>
/// 模态分析 ViewModel 的 PolyMAX 识别部分（partial）：PolyMAX + 稳定图 + LSFD。
/// </summary>
public partial class ModalAnalysisViewModel
{
    // ===== 识别方法选择 =====
    public System.Collections.ObjectModel.ObservableCollection<string> MethodOptions { get; } = new()
    {
        "峰值法"
    };
    [ObservableProperty] private string _selectedMethod = "峰值法";

    // ===== PolyMAX 参数 =====
    [ObservableProperty] private int _polyMinOrder = 20;
    [ObservableProperty] private int _polyMaxOrder = 40;
    [ObservableProperty] private int _polyMinStable = 5;
    /// <summary>阶数步长（对齐 QuickModal OrderStep，默认 2）。</summary>
    [ObservableProperty] private int _polyOrderStep = 2;
    /// <summary>SVD 投影维数（对齐 QuickModal ProjectionDim；默认 20，避免在粗分辨率频谱中过拟合数学极点）。</summary>
    [ObservableProperty] private int _polyProjectionDim = 20;

    /// <summary>PolyMAX 识别频带下限（Hz）。0 = 用 FRF 全频带。</summary>
    [ObservableProperty] private double _polyFreqMin;
    /// <summary>PolyMAX 识别频带上限（Hz）。0 = 用 FRF 全频带。</summary>
    [ObservableProperty] private double _polyFreqMax;

    /// <summary>PolyMAX 运行进度 0..1（绑定进度条）。</summary>
    [ObservableProperty] private double _polyProgress;
    /// <summary>PolyMAX 是否正在运行（控制进度条显隐）。</summary>
    [ObservableProperty] private bool _polyRunning;
    /// <summary>最近一次 PolyMAX+LSFD 综合拟合质量。</summary>
    [ObservableProperty] private string _polyFitSummary = "尚未进行模态综合拟合";
    /// <summary>最终选中模态与 LR/UR 综合得到的 FRF，用于与实测曲线叠加验证。</summary>
    public FrfResult? PolymaxSynthesizedFrf { get; private set; }

    /// <summary>稳定图数据（视图绘制：每个稳定/不稳定极点的频率 vs 阶数）。</summary>
    public System.Collections.Generic.List<PoleEntry>? StabilityPoles { get; private set; }
    /// <summary>是否用 PolyMAX（控制 UI 显示稳定图）。</summary>
    public bool IsPolymax => SelectedMethod.StartsWith("PolyMAX");

    partial void OnSelectedMethodChanged(string value)
    {
        OnPropertyChanged(nameof(IsPolymax));
        OnPropertyChanged(nameof(ModalIndicatorHint));
        PersistAnalysisSettings();
    }

    partial void OnPolyMinOrderChanged(int value) => PersistAnalysisSettings();
    partial void OnPolyMaxOrderChanged(int value) => PersistAnalysisSettings();
    partial void OnPolyMinStableChanged(int value) => PersistAnalysisSettings();
    partial void OnPolyOrderStepChanged(int value) => PersistAnalysisSettings();
    partial void OnPolyProjectionDimChanged(int value) => PersistAnalysisSettings();
    partial void OnPolyFreqMinChanged(double value) => PersistAnalysisSettings();
    partial void OnPolyFreqMaxChanged(double value) => PersistAnalysisSettings();

    /// <summary>统一识别入口：按所选方法分派。</summary>
    [RelayCommand]
    private async Task Identify()
    {
        if (_frf == null) { Status = "请先计算 FRF"; return; }
        if (IsPolymax) await RunPolymaxAsync();
        else IdentifyModes();   // 峰值法（已有，在 .Frf.cs）
    }

    /// <summary>PolyMAX 完整流水线：阶数扫描 → 稳定图聚类 → LSFD 振型。</summary>
    private async Task RunPolymaxAsync()
    {
        if (!Licensing.LicenseService.Instance.IsEnabled(Licensing.Feature.Polymax))
        {
            Status = "请选择有效的识别方法";
            return;
        }
        if (_frf == null) return;
        IsBusy = true;
        PolyRunning = true;
        PolyProgress = 0;
        PolymaxSynthesizedFrf = null;
        PolyFitSummary = "正在计算稳定极点与模态综合...";
        Status = "PolyMAX 极点估计中...";
        var busyToken = BusyService.Instance.Begin("PolyMAX 识别模态中...", canCancel: true);
        var frfFull = _frf;
        // 识别频带：优先用识别页独立设置的 PolyFreqMin/Max；为 0 时回退到 FRF 频带
        double fMin = PolyFreqMin > 0 ? PolyFreqMin : FrfFreqMin;
        double fMax = PolyFreqMax > 0 ? PolyFreqMax : (FrfFreqMax <= 0 ? double.MaxValue : FrfFreqMax);

        // 频段裁剪（与 QuickModal SliceFrf 一致）：只在 [fMin,fMax] 内跑 PolyMAX，
        // 既能聚焦关心频段，又大幅减少频点数 → 显著提速。
        var frf = SliceFrf(frfFull, fMin, fMax);

        bool useCoherenceWeights = ModalIndicator.HasUsableCoherence(frf);
        var polyOpt = new PolymaxOptions
        {
            MinOrder = Math.Max(2, PolyMinOrder),
            MaxOrder = Math.Max(PolyMinOrder + 2, PolyMaxOrder),
            OrderStep = Math.Max(1, PolyOrderStep),
            ProjectionDim = Math.Min(Math.Max(2, PolyProjectionDim), Math.Max(frf.PointCount, 2)),
            WeightMode = useCoherenceWeights ? PolymaxWeight.CoherenceNls : PolymaxWeight.None
        };
        double freqResolution = frf.FreqCount > 1
            ? Math.Abs(frf.Frequencies[1] - frf.Frequencies[0])
            : 0;
        var stabOpt = new StabilityOptions
        {
            MinStableCount = Math.Max(2, PolyMinStable),
            OrderStep = Math.Max(1, PolyOrderStep),
            RequireConsecutiveOrders = true,
            // 聚类容差随实际频率分辨率调整：约 2 个分辨率单元内的稳定极点视为同一模态，
            // 既不在粗频谱上拆出不可分辨的“模态”，也不像旧的固定 2 Hz 下限那样在
            // 细分辨率/低频段把相距很远的独立模态并成一簇。分辨率无定义时回退 2 Hz。
            ClusterFreqTolHz = freqResolution > 0
                ? Math.Max(2.0 * freqResolution, freqResolution * 0.35)
                : 2.0
        };

        // 权重输入使用原始平方相干度 γ²：Polymax.Run 根据 WeightMode 在内部转换为
        // NLS 目标权重 γ²/(1-γ²)；LSFD 直接使用 γ²。集中转换可避免调用方重复/漏做。
        int nfW = frf.FreqCount, npW = frf.PointCount;
        double[,]? polyW = useCoherenceWeights ? new double[nfW, npW] : null;
        double[,]? lsfdW = useCoherenceWeights ? new double[nfW, npW] : null;
        if (useCoherenceWeights)
        {
            for (int i = 0; i < nfW; i++)
                for (int j = 0; j < npW; j++)
                {
                    // NaN 表示该频点相干度无定义；在其余频点已有有效相干度时，把它视作
                    // 不可信点（权重 0）。若整批相干度均无定义，则上面整体退回无权求解。
                    double raw = frf.Coherence[i, j];
                    double g = double.IsFinite(raw) ? Math.Clamp(raw, 0, 1) : 0.0;
                    lsfdW![i, j] = g;
                    polyW![i, j] = g;
                }
        }

        // 进度回调（节流刷新到 UI）：极点估计占 0~70%，后续稳定图/振型再补到 100%
        Action<double> onProg = p => Dispatcher.UIThread.Post(() =>
        {
            PolyProgress = p * 0.7;
            var msg = $"PolyMAX 极点估计中... {p * 70:F0}%";
            Status = msg;
            BusyService.Instance.Update(msg, p * 70);
        });
        void Stage(double prog, string text)
        {
            Dispatcher.UIThread.Post(() =>
            {
                PolyProgress = prog;
                var msg = $"{text} {prog * 100:F0}%";
                Status = msg;
                BusyService.Instance.Update(msg, prog * 100);
            });
        }

        try
        {
            var (candidateClusters, levels, cmifSelection, polyRun) = await Task.Run(() =>
            {
                var poly = Polymax.Run(frf.Frequencies, frf.H, polyW, polyOpt, onProg, busyToken);
                busyToken.ThrowIfCancellationRequested();
                Stage(0.72, "参与向量稳定判据计算中...");
                // PolyMAX 求解器已经从分子多项式恢复了 pole participation vector；不再用
                // 单极点 FRF 投影近似，近频模态的跨阶匹配与 LMS 稳定图一致得多。
                var lv = StabilityAnalyzer.Classify(poly.Orders, stabOpt, shapeFunc: null,
                    cp =>
                    {
                        busyToken.ThrowIfCancellationRequested();   // 稳定判据循环内响应取消（回调在算法循环里被调用）
                        Dispatcher.UIThread.Post(() =>
                        {
                            PolyProgress = 0.72 + cp * 0.18;   // 72%~90%
                            Status = $"参与向量稳定判据计算中... {(0.72 + cp * 0.18) * 100:F0}%";
                        });
                    });
                // LMS/Simcenter Neo 公布的自动流程：频率、阻尼、参与向量 DBSCAN 聚类，
                // 再合并过度碎片化的相似簇。CMIF 仅保留为诊断信息，不再作为硬门槛；
                // 最终自动剔除以 LSFD 综合贡献为准，避免漏掉反共振附近或弱峰模态。
                busyToken.ThrowIfCancellationRequested();
                Stage(0.9, "稳定极点 DBSCAN 聚类中...");
                var rawClusters = StabilityAnalyzer.Cluster(lv, stabOpt, freqOnly: false);
                // 频段与物理阻尼过滤；阻尼大于 25% 的结构模态候选通常为数学极点。
                rawClusters = rawClusters.Where(c => c.Frequency >= fMin && c.Frequency <= fMax
                                                      && c.Damping > 0 && c.Damping <= 0.25)
                                         .OrderBy(c => c.Frequency).ToList();

                var cmif = ModalPeakPick.Cmif(frf);
                var sel = StabilityAnalyzer.SelectCmifSupportedModes(
                    rawClusters, frf.Frequencies, cmif, fMin, fMax);
                return (rawClusters, lv, sel, poly);
            }, busyToken);

            string solverDetail = polyRun.ProjectionSkippedForOutputDependentWeights
                ? "相干加权已启用；因各测点权重不同，为保持加权方程正确，本次未做 SVD 输出投影"
                : polyRun.AppliedProjectionDim.HasValue
                    ? $"已使用 {polyRun.AppliedProjectionDim.Value} 维实正交输出投影"
                    : polyRun.WeightsApplied ? "相干加权已启用" : "未加权";
            if (polyRun.NarrowBandWarning)
                solverDetail += $"；警告：识别频带过窄（基弧长 {polyRun.BasisArcLength:F3} rad < 0.5），极点/阻尼可能不可靠，建议加宽 PolyFreqMin/Max";

            // 稳定图数据
            StabilityPoles = levels.SelectMany(l => l).ToList();

            if (candidateClusters.Count == 0)
            {
                Status = "PolyMAX 未找到连续且物理阻尼有效的稳定模态；请检查频带、信噪比和阶数范围";
                PolyFitSummary = "没有可用于综合拟合的稳定模态";
                PolymaxSynthesizedFrf = null;
                _modes = new PeakPickResult();
                ModeRows.Clear();
                IsBusy = false;
                Dispatcher.UIThread.Post(() => { FrfComputed?.Invoke(); ModeSelectionChanged?.Invoke(); });
                return;
            }

            // LMS 自动选模态的最后一步：全部稳定簇先做 LSFD+LR/UR 综合，剔除对综合 FRF
            // 贡献可忽略的簇。这里的 1e-4 表示移除该模态导致的误差增量不足测量能量 0.01%。
            Stage(0.92, "LSFD 模态综合与贡献筛选中...");
            var preliminaryPoles = candidateClusters.Select(c => c.Pole).ToArray();
            var preliminaryFit = await Task.Run(() =>
                LsfdEstimator.Estimate(frf.Frequencies, frf.H, preliminaryPoles, lsfdW,
                    new ShapeOutlierOptions { Enabled = false }), busyToken);
            var preliminarySynthesis = await Task.Run(() =>
                ModalSynthesis.Evaluate(frf.Frequencies, frf.H, preliminaryPoles,
                    preliminaryFit, lsfdW), busyToken);
            const double minimumContributionFraction = 1e-4;
            var selectedIndices = Enumerable.Range(0, candidateClusters.Count)
                .Where(i => i < preliminarySynthesis.ModeContributionFractions.Length
                            && preliminarySynthesis.ModeContributionFractions[i] >= minimumContributionFraction)
                .ToArray();
            var clusters = selectedIndices.Select(i => candidateClusters[i]).ToList();

            if (clusters.Count == 0)
            {
                Status = $"PolyMAX 找到 {candidateClusters.Count} 个稳定极点簇，但其 LSFD 综合贡献均低于 0.01%；{solverDetail}；请缩小识别频带或提高信噪比";
                PolyFitSummary = $"候选 {candidateClusters.Count} 阶；全部因综合贡献过低被剔除";
                PolymaxSynthesizedFrf = null;
                _modes = new PeakPickResult();
                ModeRows.Clear();
                Dispatcher.UIThread.Post(() => { FrfComputed?.Invoke(); ModeSelectionChanged?.Invoke(); });
                return;
            }

            // 最终极点重新 LSFD 拟合；未抑制的留数用于严格综合验证，Clip 后的振型用于显示，
            // 避免为改善图形外观而篡改拟合质量指标。
            var outlierOpt = new ShapeOutlierOptions
            {
                Enabled = true,
                MadFactor = 5.0,
                Action = OutlierAction.Clip
            };
            Stage(0.96, "最终 LSFD 振型与综合验证中...");
            var finalPoles = clusters.Select(c => c.Pole).ToArray();
            var finalRawShapes = selectedIndices.Length == candidateClusters.Count
                ? preliminaryFit
                : await Task.Run(() => LsfdEstimator.Estimate(
                    frf.Frequencies, frf.H, finalPoles, lsfdW,
                    new ShapeOutlierOptions { Enabled = false }), busyToken);
            var synthesis = await Task.Run(() => ModalSynthesis.Evaluate(
                frf.Frequencies, frf.H, finalPoles, finalRawShapes, lsfdW), busyToken);
            var shapes = await Task.Run(() => LsfdEstimator.Estimate(
                frf.Frequencies, frf.H, finalPoles, lsfdW, outlierOpt), busyToken);
            PolyProgress = 1.0;

            PolymaxSynthesizedFrf = new FrfResult
            {
                Frequencies = frf.Frequencies,
                H = synthesis.Synthesized,
                Coherence = frf.Coherence,
                PointNumbers = frf.PointNumbers,
                UsedSegmentLength = frf.UsedSegmentLength,
                SegmentCount = frf.SegmentCount,
                ExpWindowAlpha = frf.ExpWindowAlpha
            };
            PolyFitSummary = $"综合拟合：相关性 {synthesis.Correlation * 100:F1}% · 相对误差 {synthesis.RelativeError * 100:F1}% · LR/UR 已启用";

            // 组装成与峰值法相同的结果结构，复用同一套振型/表格显示
            int nm = clusters.Count;
            int np = frf.PointCount;
            var modesReal = new double[nm, np];
            var modesC = new Complex[nm, np];
            var freqs = new double[nm];
            var damps = new double[nm];
            for (int k = 0; k < nm; k++)
            {
                freqs[k] = clusters[k].Frequency;
                // 聚类阻尼来自带指数窗的 FRF，含窗附加衰减 α/(2πf)。填表/导出前先扣窗
                // 还原物理阻尼，与手动点选路径（ToggleModeAtFrequencyCore 同样调用
                // CorrectOmaDamping）一致；RefreshSynthesisAfterManualEditAsync 用表中
                // 阻尼重建极点拟合原始带窗 FRF 时会再把 α/(2πf) 加回，两侧互为逆运算。
                damps[k] = CorrectOmaDamping(freqs[k], clusters[k].Damping);
                for (int j = 0; j < np; j++)
                {
                    modesReal[k, j] = k < shapes.Real.GetLength(0) ? shapes.Real[k, j] : 0;
                    modesC[k, j] = k < shapes.Complex.GetLength(0) ? shapes.Complex[k, j] : Complex.Zero;
                }
            }
            _modes = new PeakPickResult
            {
                Frequencies = freqs,
                Dampings = damps,
                ModesReal = modesReal,
                ModesComplex = modesC,
                PeakIndices = Array.Empty<int>()
            };

            FillModeRows(_modes);
            int rejected = Math.Max(0, candidateClusters.Count - nm);
            int cmifSupported = cmifSelection.Modes.Count;
            Status = rejected > 0
                ? $"PolyMAX 自动选择 {nm} 阶模态，按综合贡献剔除 {rejected} 个稳定簇；拟合相关性 {synthesis.Correlation * 100:F1}%，误差 {synthesis.RelativeError * 100:F1}%；CMIF 支撑 {cmifSupported}/{candidateClusters.Count}（仅诊断）；{solverDetail}"
                : $"PolyMAX 自动选择 {nm} 阶模态；拟合相关性 {synthesis.Correlation * 100:F1}%，误差 {synthesis.RelativeError * 100:F1}%；CMIF 支撑 {cmifSupported}/{candidateClusters.Count}（仅诊断）；{solverDetail}";
            Dispatcher.UIThread.Post(() => { FrfComputed?.Invoke(); ModeSelectionChanged?.Invoke(); });
        }
        catch (OperationCanceledException) { Status = "PolyMAX 识别已取消"; }
        catch (Exception ex) { Status = $"PolyMAX 出错: {ex.Message}"; }
        finally { IsBusy = false; PolyRunning = false; PolyProgress = 0; BusyService.Instance.End(); }
    }

    /// <summary>
    /// 单极点投影估计某极点的振型（各测点复值），用于稳定图的 MAC 振型稳定判据。
    /// φ_j = Σ_i conj(k_i)·H[i,j] / Σ_i |k_i|²，其中 k_i = 1/(jω_i − λ)（单自由度最小二乘留数）。
    /// 这是轻量近似（非完整 LSFD），足够做跨阶 MAC 比较剔除数学极点。
    /// </summary>
    private static Complex[] EstimatePoleShape(double[] freqs, Complex[,] H, Complex pole)
    {
        int nf = freqs.Length, np = H.GetLength(1);
        var k = new Complex[nf];
        double sumk2 = 0;
        for (int i = 0; i < nf; i++)
        {
            var jw = new Complex(0, 2 * Math.PI * freqs[i]);
            var denom = jw - pole;
            k[i] = denom.Magnitude > 1e-30 ? Complex.One / denom : Complex.Zero;
            sumk2 += k[i].Real * k[i].Real + k[i].Imaginary * k[i].Imaginary;
        }
        var shape = new Complex[np];
        if (sumk2 < 1e-30) return shape;
        for (int j = 0; j < np; j++)
        {
            Complex acc = Complex.Zero;
            for (int i = 0; i < nf; i++)
                acc += Complex.Conjugate(k[i]) * H[i, j];
            shape[j] = acc / sumk2;
        }
        return shape;
    }

    /// <summary>
    /// 稳定图上单击的交互：把点击频率吸附到最近的稳定极点(蓝/绿候选)，
    /// 该频率附近已有模态则移除，否则用 LSFD 求振型后新增。供视图在 PolyMAX 模式下调用。
    /// 返回 Task（而非 async void）并整体捕获异常，避免异常被顶层吞掉后用户点稳定图“毫无反应”。
    /// </summary>
    public async Task ToggleModeAtFrequencyAsync(double clickFreqHz, double plotHitToleranceHz = double.NaN)
    {
        try { await ToggleModeAtFrequencyCore(clickFreqHz, plotHitToleranceHz); }
        catch (Exception ex)
        {
            Log.Error("稳定图点选模态失败", ex);
            Status = "添加/移除模态失败：" + ex.Message;
        }
    }

    private async Task ToggleModeAtFrequencyCore(double clickFreqHz, double plotHitToleranceHz)
    {
        if (_frf == null || _frf.FreqCount == 0) { Status = "请先计算 FRF/半谱"; return; }
        double span = _frf.Frequencies[^1] - _frf.Frequencies[0];
        double resolution = _frf.Frequencies.Length > 1
            ? Math.Abs(span) / (_frf.Frequencies.Length - 1)
            : 0;
        // 删除命中必须与屏幕上的已有模态竖线足够接近。旧逻辑最少使用 2 Hz，
        // 在 0~20 Hz 频带会把相距很远的 7.5 Hz 和 9.22 Hz 误判成同一个模态。
        double visualHitTol = double.IsFinite(plotHitToleranceHz) && plotHitToleranceHz > 0
            ? plotHitToleranceHz
            : Math.Max(resolution * 1.5, Math.Abs(span) * 0.002);
        double removeTol = Math.Max(resolution * 1.25, visualHitTol);
        // 新增时允许在已有模态命中范围的约两倍内吸附到稳定极点，符合图上点选手感。
        double snapTol = Math.Max(resolution * 3.0, visualHitTol * 2.0);

        // 1) 点到已有模态附近 → 移除
        var hit = ModeRows
            .OrderBy(m => Math.Abs(m.Frequency - clickFreqHz))
            .FirstOrDefault(m => Math.Abs(m.Frequency - clickFreqHz) <= removeTol);
        if (hit != null)
        {
            if (ConfirmModeEdit && ConfirmRequested != null
                && !await ConfirmRequested.Invoke($"移除 {hit.Frequency:F2} Hz 处的模态？"))
                return;
            double f0 = hit.Frequency;
            ModeRows.Remove(hit);
            ReindexModes();
            SyncModesFromRows();
            SelectedMode = ModeRows.Count > 0 ? ModeRows[0] : null;
            await RefreshSynthesisAfterManualEditAsync();
            Status = $"已移除模态 {f0:F2} Hz，剩 {ModeRows.Count} 阶";
            Dispatcher.UIThread.Post(() => { FrfComputed?.Invoke(); ModeSelectionChanged?.Invoke(); });
            return;
        }

        // 2) 吸附到最近的稳定候选极点（频率+振型稳定的蓝/绿点）
        PoleEntry? best = null; double bestDf = double.MaxValue;
        if (StabilityPoles != null)
            foreach (var pe in StabilityPoles)
            {
                if (!pe.StableFV) continue;
                double df = Math.Abs(pe.Frequency - clickFreqHz);
                if (df < bestDf) { bestDf = df; best = pe; }
            }
        if (best == null || bestDf > snapTol)
        {
            Status = $"{clickFreqHz:F1} Hz 附近没有稳定极点可选";
            return;
        }

        // 点击落在稳定极点附近、但没有真正命中已有模态竖线时，禁止添加同频重复项。
        // 用户如要删除，需直接点击对应的红色模态线。
        var duplicate = ModeRows
            .OrderBy(m => Math.Abs(m.Frequency - best.Frequency))
            .FirstOrDefault(m => Math.Abs(m.Frequency - best.Frequency) <= removeTol);
        if (duplicate != null)
        {
            Status = $"{duplicate.Frequency:F2} Hz 已在模态列表中；如需移除，请直接点击对应红色模态线";
            return;
        }

        // 添加前确认（避免误点稳定图就自动加一阶模态）
        if (ConfirmModeEdit && ConfirmRequested != null
            && !await ConfirmRequested.Invoke($"在 {best.Frequency:F2} Hz 处添加一阶模态？"))
            return;

        // 3) 用 LSFD 求该极点振型并新增：放后台线程执行，并与 RunPolymax 一样先按识别频带裁剪 FRF，
        //    既不卡 UI，也避免无关频段参与单极点拟合造成振型偏差。
        double fMin = PolyFreqMin > 0 ? PolyFreqMin : FrfFreqMin;
        double fMax = PolyFreqMax > 0 ? PolyFreqMax : (FrfFreqMax <= 0 ? double.MaxValue : FrfFreqMax);
        var frfId = SliceFrf(_frf, fMin, fMax);
        var outlierOpt = new ShapeOutlierOptions { Enabled = true, MadFactor = 5.0, Action = OutlierAction.Clip };
        var pole = best.Pole;
        var shapes = await Task.Run(() =>
            LsfdEstimator.Estimate(frfId.Frequencies, frfId.H, new[] { pole }, null, outlierOpt));
        int np = frfId.PointCount;
        var shape = new double[np];
        for (int j = 0; j < np && shapes.Real.GetLength(0) > 0; j++) shape[j] = shapes.Real[0, j];

        // 复振型（归一化 + MPC）
        var shapeC = System.Array.Empty<Complex>();
        double mpc = 1.0;
        double realMax = 0;
        if (shapes.Complex.GetLength(0) > 0 && shapes.Complex.GetLength(1) == np)
        {
            shapeC = new Complex[np];
            double maxMag = 0;
            for (int j = 0; j < np; j++) { double m = shapes.Complex[0, j].Magnitude; if (m > maxMag) maxMag = m; }
            realMax = maxMag;
            if (maxMag < 1e-30) maxMag = 1.0;
            for (int j = 0; j < np; j++) shapeC[j] = shapes.Complex[0, j] / maxMag;
            mpc = ModalValidation.Mpc(shapeC);
        }

        double f = best.Frequency;
        double zeta = CorrectOmaDamping(f, best.Damping);
        var row = new ModeRow
        {
            Frequency = f,
            DampingPercent = zeta * 100.0,
            DampingReliable = best.StableD,   // 阻尼也稳定(绿点)才标可信
            Nums = frfId.PointNumbers,
            Shape = shape,
            ShapeComplex = shapeC,
            RealMaxMag = realMax,
            Mpc = mpc
        };
        ModeRows.Add(row);
        ReindexModes();
        SyncModesFromRows();
        SelectedMode = row;
        await RefreshSynthesisAfterManualEditAsync();
        Status = $"已添加模态 {f:F2} Hz（阻尼 {zeta * 100:F3}%），共 {ModeRows.Count} 阶";
        Dispatcher.UIThread.Post(() => { FrfComputed?.Invoke(); ModeSelectionChanged?.Invoke(); });
    }

    /// <summary>
    /// 稳定图手动增删模态后重新联合拟合全部留数并刷新综合曲线。否则界面上的橙色
    /// “LSFD 综合”仍对应自动选择前的旧模态集合，会给用户错误的拟合判断。
    /// </summary>
    private async Task RefreshSynthesisAfterManualEditAsync()
    {
        if (_frf == null || ModeRows.Count == 0)
        {
            PolymaxSynthesizedFrf = null;
            PolyFitSummary = ModeRows.Count == 0 ? "当前没有可综合的模态" : "尚未进行模态综合拟合";
            return;
        }

        try
        {
            double fMin = PolyFreqMin > 0 ? PolyFreqMin : FrfFreqMin;
            double fMax = PolyFreqMax > 0 ? PolyFreqMax : (FrfFreqMax <= 0 ? double.MaxValue : FrfFreqMax);
            FrfResult frf = SliceFrf(_frf, fMin, fMax);
            int nf = frf.FreqCount, np = frf.PointCount;
            double[,]? weights = null;
            if (ModalIndicator.HasUsableCoherence(frf))
            {
                weights = new double[nf, np];
                for (int i = 0; i < nf; i++)
                    for (int o = 0; o < np; o++)
                    {
                        double value = frf.Coherence[i, o];
                        weights[i, o] = double.IsFinite(value) ? Math.Clamp(value, 0, 1) : 0;
                    }
            }

            var poles = new Complex[ModeRows.Count];
            for (int k = 0; k < ModeRows.Count; k++)
            {
                double frequency = ModeRows[k].Frequency;
                // 表中显示值已扣除了指数窗衰减；用于拟合原始带窗 FRF 时必须加回。
                double damping = Math.Max(0, ModeRows[k].DampingPercent / 100.0);
                if (frf.ExpWindowAlpha > 0 && frequency > 0)
                    damping += frf.ExpWindowAlpha / (2.0 * Math.PI * frequency);
                damping = Math.Clamp(damping, 0, 0.999999999);
                double wn = 2 * Math.PI * frequency;
                poles[k] = new Complex(-damping * wn,
                    wn * Math.Sqrt(Math.Max(0, 1 - damping * damping)));
            }

            var rawFit = await Task.Run(() => LsfdEstimator.Estimate(
                frf.Frequencies, frf.H, poles, weights,
                new ShapeOutlierOptions { Enabled = false }));
            var synthesis = await Task.Run(() => ModalSynthesis.Evaluate(
                frf.Frequencies, frf.H, poles, rawFit, weights));
            var displayFit = await Task.Run(() => LsfdEstimator.Estimate(
                frf.Frequencies, frf.H, poles, weights,
                new ShapeOutlierOptions { Enabled = true, MadFactor = 5.0, Action = OutlierAction.Clip }));

            for (int k = 0; k < ModeRows.Count; k++)
            {
                var real = new double[np];
                var complex = new Complex[np];
                double maxMagnitude = 0;
                for (int o = 0; o < np; o++)
                {
                    real[o] = displayFit.Real[k, o];
                    complex[o] = displayFit.Complex[k, o];
                    maxMagnitude = Math.Max(maxMagnitude, complex[o].Magnitude);
                }
                double normalization = maxMagnitude > 1e-30 ? maxMagnitude : 1.0;
                for (int o = 0; o < np; o++) complex[o] /= normalization;
                ModeRows[k].Shape = real;
                ModeRows[k].ShapeComplex = complex;
                ModeRows[k].RealMaxMag = maxMagnitude;
                ModeRows[k].Mpc = ModalValidation.Mpc(complex);
            }
            SyncModesFromRows();
            PolymaxSynthesizedFrf = new FrfResult
            {
                Frequencies = frf.Frequencies,
                H = synthesis.Synthesized,
                Coherence = frf.Coherence,
                PointNumbers = frf.PointNumbers,
                UsedSegmentLength = frf.UsedSegmentLength,
                SegmentCount = frf.SegmentCount,
                ExpWindowAlpha = frf.ExpWindowAlpha
            };
            PolyFitSummary = $"综合拟合：相关性 {synthesis.Correlation * 100:F1}% · 相对误差 {synthesis.RelativeError * 100:F1}% · LR/UR 已启用";
        }
        catch (Exception ex)
        {
            PolymaxSynthesizedFrf = null;
            PolyFitSummary = "手动修改后综合拟合失败：" + ex.Message;
        }
    }

    /// <summary>用当前 ModeRows 重建 _modes（频率/阻尼/振型矩阵），保持导出/验证等下游一致。</summary>
    private void SyncModesFromRows()
    {
        int nm = ModeRows.Count;
        int np = _frf?.PointCount ?? (nm > 0 ? ModeRows[0].Shape.Length : 0);
        var freqs = new double[nm];
        var damps = new double[nm];
        var modesReal = new double[nm, np];
        var modesComplex = new Complex[nm, np];
        for (int k = 0; k < nm; k++)
        {
            freqs[k] = ModeRows[k].Frequency;
            damps[k] = ModeRows[k].DampingPercent / 100.0;
            var sh = ModeRows[k].Shape;
            for (int j = 0; j < np && j < sh.Length; j++) modesReal[k, j] = sh[j];
            var shComplex = ModeRows[k].ShapeComplex;
            for (int j = 0; j < np && j < shComplex.Length; j++) modesComplex[k, j] = shComplex[j];
        }
        _modes = new PeakPickResult
        {
            Frequencies = freqs,
            Dampings = damps,
            ModesReal = modesReal,
            ModesComplex = modesComplex,
            PeakIndices = Array.Empty<int>()
        };
    }

    /// <summary>把已算好的 FRF 按 [fmin,fmax] 频段裁切（移植自 QuickModal SliceFrf），避免全频带跑 PolyMAX。</summary>
    private static FrfResult SliceFrf(FrfResult frf, double fmin, double fmax)
    {
        var keep = new System.Collections.Generic.List<int>();
        for (int i = 0; i < frf.Frequencies.Length; i++)
        {
            double f = frf.Frequencies[i];
            if (f >= fmin && f <= fmax) keep.Add(i);
        }
        if (keep.Count == 0 || keep.Count == frf.Frequencies.Length) return frf;

        int nf = keep.Count, np = frf.PointCount;
        var freqs = new double[nf];
        var H = new Complex[nf, np];
        var coh = new double[nf, np];
        for (int i = 0; i < nf; i++)
        {
            int src = keep[i];
            freqs[i] = frf.Frequencies[src];
            for (int j = 0; j < np; j++)
            {
                H[i, j] = frf.H[src, j];
                coh[i, j] = frf.Coherence[src, j];
            }
        }
        return new FrfResult
        {
            Frequencies = freqs, H = H, Coherence = coh,
            PointNumbers = frf.PointNumbers, UsedSegmentLength = frf.UsedSegmentLength,
            // 元数据同步拷贝：α 供指数窗阻尼修正、段数供质量诊断，漏拷会让下游拿到 0
            SegmentCount = frf.SegmentCount, ExpWindowAlpha = frf.ExpWindowAlpha
        };
    }
}

