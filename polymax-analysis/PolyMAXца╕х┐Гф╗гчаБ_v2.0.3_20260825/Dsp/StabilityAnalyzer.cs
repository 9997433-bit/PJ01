using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;

namespace NiScope.Dsp;

/// <summary>稳定图中的一个极点条目。</summary>
public class PoleEntry
{
    public int Order { get; set; }
    public Complex Pole { get; set; }
    public double Frequency => Math.Abs(Pole.Magnitude) / (2 * Math.PI);
    public double Damping => Pole.Magnitude > 0 ? -Pole.Real / Pole.Magnitude : 0;
    public bool StableF { get; set; }   // 频率稳定
    public bool StableD { get; set; }   // 阻尼稳定
    public bool StableV { get; set; }   // 振型(MAC)稳定
    /// <summary>该极点的振型估计（单极点投影），用于跨阶 MAC 比较。</summary>
    public Complex[]? Shape { get; set; }
    /// <summary>全稳定：频率+阻尼+振型都稳定。</summary>
    public bool Stable => StableF && StableD && StableV;
    /// <summary>聚类候选：频率+振型稳定（阻尼最噪，不作硬性要求）。</summary>
    public bool StableFV => StableF && StableV;
}

/// <summary>稳定图聚类得到的一个物理模态。</summary>
public class ModeCluster
{
    public double Frequency { get; set; }
    public double Damping { get; set; }
    public Complex Pole { get; set; }
    public int StableCount { get; set; }
    /// <summary>连续模型阶次中保持稳定的最长次数。自动选阶应优先使用它，而不是零散出现次数。</summary>
    public int ConsecutiveStableCount { get; set; }
    /// <summary>频率、阻尼和振型三项同时稳定的不同阶次数。</summary>
    public int FullyStableCount { get; set; }
    /// <summary>簇的代表性模态参与向量，用于近频模态区分和碎片簇合并。</summary>
    public Complex[]? RepresentativeVector { get; set; }
}

/// <summary>由 CMIF 对稳定极点候选簇进行峰值支撑筛选后的结果。</summary>
public sealed class CmifModeSelectionResult
{
    public List<ModeCluster> Modes { get; init; } = new();
    public int InputClusterCount { get; init; }
    public int SupportedPeakCount { get; init; }
    public double FrequencyResolutionHz { get; init; }
}

public class StabilityOptions
{
    /// <summary>频率稳定容差（相对）。LMS 默认 1%。</summary>
    public double FreqTolerance { get; set; } = 0.01;
    /// <summary>阻尼稳定容差（相对）。LMS 默认 5%。</summary>
    public double DampingTolerance { get; set; } = 0.05;
    /// <summary>振型稳定 MAC 阈值。LMS 默认 2% 向量容差 → MAC ≥ 0.98。</summary>
    public double MacThreshold { get; set; } = 0.98;
    public double ClusterFreqTolHz { get; set; } = 2.0;
    /// <summary>DBSCAN 聚类频率相对邻域；绝对/相对容差取较大值。</summary>
    public double ClusterRelativeFreqTolerance { get; set; } = 0.01;
    /// <summary>DBSCAN 聚类的相对阻尼邻域。阻尼比本身噪声较大，默认比稳定判据宽。</summary>
    public double ClusterDampingTolerance { get; set; } = 0.75;
    /// <summary>同一密度簇内参与向量的最低 MAC。</summary>
    public double ClusterMacThreshold { get; set; } = 0.90;
    /// <summary>DBSCAN 核心点最小邻居数（含自身）；最终仍按不同且连续模型阶次筛选。</summary>
    public int ClusterMinPoints { get; set; } = 2;
    /// <summary>启用 LMS/Simcenter 自动选模态同类的多特征密度聚类。</summary>
    public bool UseDensityClustering { get; set; } = true;
    /// <summary>合并被 DBSCAN 轻微拆碎、但频率/阻尼/参与向量一致的簇。</summary>
    public bool MergeFragmentedClusters { get; set; } = true;
    public double MergeMacThreshold { get; set; } = 0.95;
    public int MinStableCount { get; set; } = 4;
    /// <summary>PolyMAX 扫阶步长，用于判断稳定极点是否在相邻阶次连续出现。</summary>
    public int OrderStep { get; set; } = 2;
    /// <summary>自动聚类要求稳定极点连续跨阶出现，避免零散数学极点累计成“稳定模态”。</summary>
    public bool RequireConsecutiveOrders { get; set; } = true;
    /// <summary>聚类是否要求振型(MAC)稳定（剔除数学极点）。默认要求。</summary>
    public bool RequireVectorStable { get; set; } = true;
}

/// <summary>
/// 稳定图分类 + 聚类。移植自 QuickModal.StabilityAnalyzer。
/// 跨阶比较极点频率/阻尼是否稳定，再把稳定极点聚成物理模态。
/// </summary>
public static class StabilityAnalyzer
{
    /// <summary>
    /// 稳定图分类。逐阶与上一阶最近极点比较：频率1%→StableF，阻尼5%→StableD，
    /// 振型 MAC≥阈值→StableV（LMS 同款判据）。shapeFunc 提供各极点的振型估计用于 MAC。
    /// </summary>
    public static List<List<PoleEntry>> Classify(IReadOnlyList<PolymaxOrderResult> orders, StabilityOptions opt,
        Func<Complex, Complex[]>? shapeFunc = null, Action<double>? progress = null)
    {
        var levels = new List<List<PoleEntry>>();
        List<PoleEntry>? prev = null;
        int total = Math.Max(1, orders.Count);
        int done = 0;
        foreach (var ord in orders)
        {
            var current = new List<PoleEntry>(ord.Poles.Length);
            for (int poleIndex = 0; poleIndex < ord.Poles.Length; poleIndex++)
            {
                Complex pole = ord.Poles[poleIndex];
                // 优先使用 p-LSCF 分子系数给出的参与向量；这与 PolyMAX 稳定图的 vector
                // 判据一致。旧的单极点 FRF 投影仅作为兼容旧结果/外部调用的后备。
                Complex[]? shape = ord.PoleVectors != null && poleIndex < ord.PoleVectors.Length
                    ? ord.PoleVectors[poleIndex]
                    : shapeFunc?.Invoke(pole);
                current.Add(new PoleEntry { Order = ord.Order, Pole = pole, Shape = shape });
            }
            if (prev != null)
            {
                var usedPrev = new HashSet<PoleEntry>();   // 一对一约束：每个上一阶极点至多被一个当前极点匹配
                foreach (var e in current)
                {
                    if (e.Frequency <= 0) continue;
                    // 在频率门限内按“频率漂移 + 参与向量不相似度”匹配。只取最近频率会在
                    // 两个密集模态交叉漂移时串轨，LMS 的 vector 稳定判据正是用来消歧的。
                    PoleEntry? best = null; double bestDf = double.MaxValue; double bestScore = double.MaxValue;
                    foreach (var pe in prev)
                    {
                        if (usedPrev.Contains(pe)) continue;
                        double df = Math.Abs(pe.Frequency - e.Frequency);
                        double rel = df / e.Frequency;
                        if (rel >= opt.FreqTolerance) continue;
                        double vectorPenalty = HasUsableVector(e.Shape) && HasUsableVector(pe.Shape)
                            ? 1.0 - MacComplex(e.Shape!, pe.Shape!)
                            : 0.0;
                        double score = rel / Math.Max(opt.FreqTolerance, 1e-12) + vectorPenalty;
                        if (score < bestScore) { bestScore = score; bestDf = df; best = pe; }
                    }
                    if (best == null) continue;
                    if (bestDf / e.Frequency < opt.FreqTolerance)
                    {
                        usedPrev.Add(best);   // 占用，避免多个当前极点共用同一上一阶极点虚增稳定
                        e.StableF = true;
                        var pz = best.Damping;
                        if (pz > 0 && Math.Abs(pz - e.Damping) / pz < opt.DampingTolerance)
                            e.StableD = true;
                        // 振型 MAC 稳定：与匹配的上一阶极点振型比较
                        if (HasUsableVector(e.Shape) && HasUsableVector(best.Shape))
                        {
                            double mac = MacComplex(e.Shape!, best.Shape!);
                            if (mac >= opt.MacThreshold) e.StableV = true;
                        }
                        else
                        {
                            e.StableV = true;   // 无振型可比时不阻断
                        }
                    }
                }
            }
            levels.Add(current);
            prev = current;
            progress?.Invoke((double)(++done) / total);
        }
        return levels;
    }

    /// <summary>两个复振型的 MAC = |φ1ᴴφ2|² / ((φ1ᴴφ1)(φ2ᴴφ2))，范围 0~1。</summary>
    private static double MacComplex(Complex[] a, Complex[] b)
    {
        int n = Math.Min(a.Length, b.Length);
        if (n == 0) return 0;
        Complex cross = Complex.Zero;
        double aa = 0, bb = 0;
        for (int i = 0; i < n; i++)
        {
            cross += Complex.Conjugate(a[i]) * b[i];
            aa += a[i].Real * a[i].Real + a[i].Imaginary * a[i].Imaginary;
            bb += b[i].Real * b[i].Real + b[i].Imaginary * b[i].Imaginary;
        }
        double denom = aa * bb;
        return denom > 1e-30 ? (cross.Real * cross.Real + cross.Imaginary * cross.Imaginary) / denom : 0;
    }

    public static List<ModeCluster> Cluster(IReadOnlyList<List<PoleEntry>> levels,
        StabilityOptions opt, bool freqOnly = false)
    {
        // 聚类候选：freqOnly→仅频率稳定；否则按 LMS 取"频率+振型稳定"(可选)，剔除数学极点
        Func<PoleEntry, bool> isCandidate = freqOnly
            ? (e => e.StableF)
            : (opt.RequireVectorStable ? (e => e.StableFV) : (e => e.StableF));

        var flat = levels.SelectMany(l => l)
            .Where(isCandidate)
            .OrderBy(e => e.Frequency)
            .ToList();
        if (flat.Count == 0) return new List<ModeCluster>();

        var clusters = opt.UseDensityClustering
            ? DensityClusters(flat, opt)
            : FrequencyClusters(flat, opt.ClusterFreqTolHz);
        if (opt.MergeFragmentedClusters && clusters.Count > 1)
            clusters = MergeFragments(clusters, opt);

        var result = new List<ModeCluster>();
        foreach (var c in clusters)
        {
            // 按"不同模型阶次"计数，而非极点条目数：同一阶的多个极点落入同一簇时不应虚增稳定度。
            var orders = c.Select(x => x.Order).Distinct().OrderBy(x => x).ToArray();
            int distinctOrders = orders.Length;
            int consecutive = LongestConsecutiveRun(orders, Math.Max(1, opt.OrderStep));
            if (distinctOrders < opt.MinStableCount) continue;
            if (opt.RequireConsecutiveOrders && consecutive < opt.MinStableCount) continue;
            var fs = c.Select(x => x.Frequency).OrderBy(x => x).ToArray();
            var ds = c.Select(x => x.Damping).OrderBy(x => x).ToArray();
            double frequency = Median(fs);
            double damping = Median(ds);
            // LSFD 后续使用 Pole，而界面显示 Frequency/Damping。不能从“频率中位条目”
            // 随机带入另一个阻尼，否则显示参数与实际拟合极点不一致。
            double wn = 2 * Math.PI * frequency;
            double boundedDamping = Math.Clamp(damping, 0.0, 0.999999999);
            var representativePole = new Complex(
                -boundedDamping * wn,
                wn * Math.Sqrt(Math.Max(0.0, 1.0 - boundedDamping * boundedDamping)));
            result.Add(new ModeCluster
            {
                Frequency = frequency,
                Damping = damping,
                Pole = representativePole,
                StableCount = distinctOrders,
                ConsecutiveStableCount = consecutive,
                FullyStableCount = c.Where(x => x.Stable).Select(x => x.Order).Distinct().Count(),
                RepresentativeVector = RepresentativeVector(c, frequency, damping)
            });
        }
        return result.OrderBy(c => c.Frequency).ToList();
    }

    private static List<List<PoleEntry>> FrequencyClusters(List<PoleEntry> flat, double toleranceHz)
    {
        var clusters = new List<List<PoleEntry>>();
        var current = new List<PoleEntry> { flat[0] };
        for (int i = 1; i < flat.Count; i++)
        {
            double center = Median(current.Select(x => x.Frequency));
            if (Math.Abs(flat[i].Frequency - center) <= toleranceHz) current.Add(flat[i]);
            else { clusters.Add(current); current = new List<PoleEntry> { flat[i] }; }
        }
        clusters.Add(current);
        return clusters;
    }

    /// <summary>
    /// Siemens Neo 公布的自动流程首先在频率、阻尼、模态参与向量上做 DBSCAN。
    /// 这里使用物理量门限形式的 DBSCAN，避免量纲缩放随数据集范围改变。
    /// </summary>
    private static List<List<PoleEntry>> DensityClusters(List<PoleEntry> points, StabilityOptions opt)
    {
        const int Unclassified = -1;
        const int Noise = -2;
        int minPoints = Math.Max(2, opt.ClusterMinPoints);
        var labels = Enumerable.Repeat(Unclassified, points.Count).ToArray();
        var visited = new bool[points.Count];
        int clusterId = 0;

        for (int i = 0; i < points.Count; i++)
        {
            if (visited[i]) continue;
            visited[i] = true;
            var neighbours = RegionQuery(points, i, opt);
            if (neighbours.Count < minPoints) { labels[i] = Noise; continue; }

            labels[i] = clusterId;
            var queue = new Queue<int>(neighbours.Where(x => x != i));
            var queued = new HashSet<int>(queue);
            while (queue.Count > 0)
            {
                int j = queue.Dequeue();
                if (!visited[j])
                {
                    visited[j] = true;
                    var around = RegionQuery(points, j, opt);
                    if (around.Count >= minPoints)
                        foreach (int k in around)
                            if (queued.Add(k)) queue.Enqueue(k);
                }
                if (labels[j] == Unclassified || labels[j] == Noise) labels[j] = clusterId;
            }
            clusterId++;
        }

        var clusters = new List<List<PoleEntry>>();
        for (int id = 0; id < clusterId; id++)
            clusters.Add(Enumerable.Range(0, points.Count)
                .Where(i => labels[i] == id).Select(i => points[i]).ToList());
        return clusters;
    }

    private static List<int> RegionQuery(List<PoleEntry> points, int index, StabilityOptions opt)
    {
        var result = new List<int>();
        for (int i = 0; i < points.Count; i++)
            if (AreClusterNeighbours(points[index], points[i], opt)) result.Add(i);
        return result;
    }

    private static bool AreClusterNeighbours(PoleEntry a, PoleEntry b, StabilityOptions opt)
    {
        double averageFrequency = 0.5 * (a.Frequency + b.Frequency);
        double fTol = Math.Max(opt.ClusterFreqTolHz,
            Math.Max(0, opt.ClusterRelativeFreqTolerance) * averageFrequency);
        if (Math.Abs(a.Frequency - b.Frequency) > fTol) return false;

        bool vectorsUsable = HasUsableVector(a.Shape) && HasUsableVector(b.Shape);
        if (vectorsUsable && MacComplex(a.Shape!, b.Shape!) < opt.ClusterMacThreshold) return false;

        // 对无参与向量的旧调用保持向后兼容，仅按频率聚类；有参与向量时才把阻尼作为
        // DBSCAN 的第三个物理特征，且采用宽容差以适应低阻尼估计的高方差。
        if (vectorsUsable && a.Damping > 0 && b.Damping > 0)
        {
            double scale = Math.Max(a.Damping, b.Damping);
            if (Math.Abs(a.Damping - b.Damping) / scale > opt.ClusterDampingTolerance) return false;
        }
        return true;
    }

    private static List<List<PoleEntry>> MergeFragments(List<List<PoleEntry>> input, StabilityOptions opt)
    {
        var clusters = input.Select(c => new List<PoleEntry>(c)).ToList();
        bool changed;
        do
        {
            changed = false;
            for (int i = 0; i < clusters.Count && !changed; i++)
            {
                double fi = Median(clusters[i].Select(x => x.Frequency));
                double di = Median(clusters[i].Select(x => x.Damping));
                Complex[]? vi = RepresentativeVector(clusters[i], fi, di);
                for (int j = i + 1; j < clusters.Count; j++)
                {
                    double fj = Median(clusters[j].Select(x => x.Frequency));
                    double dj = Median(clusters[j].Select(x => x.Damping));
                    double fTol = 1.75 * Math.Max(opt.ClusterFreqTolHz,
                        opt.ClusterRelativeFreqTolerance * 0.5 * (fi + fj));
                    if (Math.Abs(fi - fj) > fTol) continue;
                    double dScale = Math.Max(di, dj);
                    if (dScale > 0 && Math.Abs(di - dj) / dScale > opt.ClusterDampingTolerance) continue;
                    Complex[]? vj = RepresentativeVector(clusters[j], fj, dj);
                    if (!HasUsableVector(vi) || !HasUsableVector(vj)
                        || MacComplex(vi!, vj!) < opt.MergeMacThreshold) continue;
                    clusters[i].AddRange(clusters[j]);
                    clusters.RemoveAt(j);
                    changed = true;
                    break;
                }
            }
        } while (changed);
        return clusters;
    }

    private static Complex[]? RepresentativeVector(List<PoleEntry> entries, double frequency, double damping)
    {
        PoleEntry? representative = entries
            .Where(e => HasUsableVector(e.Shape))
            .OrderBy(e => Math.Abs(e.Frequency - frequency) / Math.Max(frequency, 1e-12)
                          + Math.Abs(e.Damping - damping) / Math.Max(damping, 1e-6))
            .FirstOrDefault();
        if (representative?.Shape == null) return null;
        var copy = representative.Shape.ToArray();
        double norm = Math.Sqrt(copy.Sum(x => x.Real * x.Real + x.Imaginary * x.Imaginary));
        if (norm <= 1e-30) return null;
        for (int i = 0; i < copy.Length; i++) copy[i] /= norm;
        return copy;
    }

    private static bool HasUsableVector(Complex[]? vector)
    {
        if (vector == null || vector.Length == 0) return false;
        double energy = 0;
        foreach (Complex value in vector)
        {
            if (!double.IsFinite(value.Real) || !double.IsFinite(value.Imaginary)) return false;
            energy += value.Real * value.Real + value.Imaginary * value.Imaginary;
        }
        return energy > 1e-24;
    }

    /// <summary>
    /// 用 CMIF 的局部显著峰筛选自动聚类结果。稳定图中的全部极点仍保留用于人工判断，
    /// 这里只决定哪些簇可自动进入右侧“模态结果”。同一个可分辨 CMIF 峰最多自动选择一阶。
    /// </summary>
    public static CmifModeSelectionResult SelectCmifSupportedModes(
        IReadOnlyList<ModeCluster> clusters,
        IReadOnlyList<double> frequencies,
        IReadOnlyList<double> cmif,
        double freqMin,
        double freqMax,
        double minProminenceDb = 0.35,
        double maxDampingRatio = 0.25)
    {
        double df = EstimateResolution(frequencies);
        if (clusters.Count == 0 || frequencies.Count < 3 || cmif.Count != frequencies.Count)
        {
            return new CmifModeSelectionResult
            {
                InputClusterCount = clusters.Count,
                FrequencyResolutionHz = df
            };
        }

        var db = new double[cmif.Count];
        for (int i = 0; i < cmif.Count; i++)
            db[i] = 20.0 * Math.Log10(Math.Max(cmif[i], 1e-30));

        // 四个频点的局部窗口既能识别宽峰，也能抑制单点噪声毛刺。
        const int prominenceRadius = 4;
        var peaks = new List<int>();
        for (int i = 1; i < db.Length - 1; i++)
        {
            double f = frequencies[i];
            if (f < freqMin || (freqMax > 0 && f > freqMax)) continue;
            if (!(db[i] >= db[i - 1] && db[i] >= db[i + 1]
                  && (db[i] > db[i - 1] || db[i] > db[i + 1]))) continue;

            int lo = Math.Max(0, i - prominenceRadius);
            int hi = Math.Min(db.Length - 1, i + prominenceRadius);
            double leftMin = double.PositiveInfinity;
            double rightMin = double.PositiveInfinity;
            for (int k = lo; k < i; k++) leftMin = Math.Min(leftMin, db[k]);
            for (int k = i + 1; k <= hi; k++) rightMin = Math.Min(rightMin, db[k]);
            double prominence = db[i] - Math.Max(leftMin, rightMin);
            if (prominence >= minProminenceDb) peaks.Add(i);
        }

        var selected = new List<ModeCluster>();
        foreach (int peak in peaks)
        {
            double peakFrequency = frequencies[peak];
            // 粗分辨率下，亚 bin 的多个极点不能当作多阶；1% 仅用于高频窄带时放宽极点漂移。
            double supportTolerance = Math.Max(df * 0.75, peakFrequency * 0.01);
            var best = clusters
                .Where(c => c.Frequency >= freqMin && (freqMax <= 0 || c.Frequency <= freqMax))
                .Where(c => c.Damping > 0 && c.Damping <= maxDampingRatio)
                .Where(c => Math.Abs(c.Frequency - peakFrequency) <= supportTolerance)
                .OrderBy(c => Math.Abs(c.Frequency - peakFrequency))
                .ThenByDescending(c => c.ConsecutiveStableCount)
                .ThenByDescending(c => c.FullyStableCount)
                .FirstOrDefault();
            if (best != null && !selected.Contains(best)) selected.Add(best);
        }

        return new CmifModeSelectionResult
        {
            Modes = selected.OrderBy(x => x.Frequency).ToList(),
            InputClusterCount = clusters.Count,
            SupportedPeakCount = peaks.Count,
            FrequencyResolutionHz = df
        };
    }

    private static int LongestConsecutiveRun(int[] orders, int step)
    {
        if (orders.Length == 0) return 0;
        int longest = 1, run = 1;
        for (int i = 1; i < orders.Length; i++)
        {
            if (orders[i] - orders[i - 1] == step) run++;
            else run = 1;
            longest = Math.Max(longest, run);
        }
        return longest;
    }

    private static double Median(IEnumerable<double> values)
    {
        var a = values.OrderBy(x => x).ToArray();
        if (a.Length == 0) return 0;
        int m = a.Length / 2;
        return a.Length % 2 == 0 ? (a[m - 1] + a[m]) * 0.5 : a[m];
    }

    private static double EstimateResolution(IReadOnlyList<double> frequencies)
    {
        var d = new List<double>();
        for (int i = 1; i < frequencies.Count; i++)
        {
            double v = frequencies[i] - frequencies[i - 1];
            if (double.IsFinite(v) && v > 0) d.Add(v);
        }
        return d.Count == 0 ? 0 : Median(d);
    }
}
