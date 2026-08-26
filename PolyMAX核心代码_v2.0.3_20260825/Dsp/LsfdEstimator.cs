using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using MathNet.Numerics.LinearAlgebra;
using MnVector = MathNet.Numerics.LinearAlgebra.Vector<double>;

namespace NiScope.Dsp;

public class ModeShapeResult
{
    /// <summary>(模态数, 测点数) 复振型 = 复留数 r_k。</summary>
    public Complex[,] Complex { get; set; } = new Complex[0, 0];
    /// <summary>实模态等价（最佳相位旋转 + 归一化到 |max|=1）。</summary>
    public double[,] Real { get; set; } = new double[0, 0];
    /// <summary>每阶被判定为异常的测点索引。</summary>
    public List<int>[] Outliers { get; set; } = Array.Empty<List<int>>();
    /// <summary>每个输出的低频残差系数，模型项为 -LR/ω²。</summary>
    public double[] LowerResidual { get; set; } = Array.Empty<double>();
    /// <summary>每个输出的高频残差/刚性项，模型项为常数 UR。</summary>
    public double[] UpperResidual { get; set; } = Array.Empty<double>();
}

/// <summary>振型异常点处理方式（与 QuickModal 一致）。</summary>
public enum OutlierAction { None, Clip, Zero, Interpolate }

/// <summary>振型异常点抑制选项（移植自 QuickModal.ShapeOutlierOptions）。</summary>
public class ShapeOutlierOptions
{
    /// <summary>是否启用异常点抑制。</summary>
    public bool Enabled { get; set; } = true;
    /// <summary>MAD 倍数阈值。x 与中位数距离超过 k·MAD·1.4826 视为异常。常用 4~6。</summary>
    public double MadFactor { get; set; } = 5.0;
    /// <summary>低相干阈值。每测点平均相干低于此值视为坏点。0 表示不启用相干检测。</summary>
    public double CoherenceFloor { get; set; } = 0.0;
    /// <summary>处理方式。</summary>
    public OutlierAction Action { get; set; } = OutlierAction.Clip;
    /// <summary>当 Action=Interpolate 时使用的几何坐标 (Np × 3)。null 时退化为 Clip。</summary>
    public double[,]? Coords { get; set; }
    /// <summary>用户强制标记为坏点的测点索引（与振型矩阵列对应）。</summary>
    public IReadOnlyList<int>? ForcedBadIndices { get; set; }
}

/// <summary>
/// LSFD: H(ω) ≈ Σ_k r_k / (jω - p_k) + UR + LR。移植自 QuickModal.LsfdEstimator（含异常点抑制）。
/// 求复留数 r_k，把实虚部当 2 个实变量做实数最小二乘。
/// </summary>
public static class LsfdEstimator
{
    public static ModeShapeResult Estimate(double[] freqs, Complex[,] H, Complex[] poles,
        double[,]? weights = null, ShapeOutlierOptions? outlierOpt = null)
    {
        int nf = freqs.Length;
        int np = H.GetLength(1);
        int nm = poles.Length;
        if (nm == 0) return new ModeShapeResult();
        if (H.GetLength(0) != nf)
            throw new ArgumentException("H 行数必须等于频率数。", nameof(H));
        if (weights != null && (weights.GetLength(0) != nf || weights.GetLength(1) != np))
            throw new ArgumentException("权重矩阵尺寸必须与 H 一致。", nameof(weights));

        int cols = 2 * nm + 2;  // 每模态 2 实变量 + LR + UR

        // 共轭极点对基函数：每阶含 r/(jω-λ) + conj(r)/(jω-conj(λ))（真实 FRF 的极点成对出现）。
        // 残差 r=a+jb（2 个实未知），其贡献 = a·P + b·Q，其中 P=u+v、Q=j(u-v)、u=1/(jω-λ)、v=1/(jω-conj(λ))。
        // 之前只用 u（缺共轭项），宽频带/大阻尼时留数/振型会偏。
        var Preal = new double[nf, nm];
        var Pimag = new double[nf, nm];
        var Qreal = new double[nf, nm];
        var Qimag = new double[nf, nm];
        for (int i = 0; i < nf; i++)
        {
            var jw = new Complex(0, 2 * Math.PI * freqs[i]);
            for (int k = 0; k < nm; k++)
            {
                var u = Complex.One / (jw - poles[k]);
                var v = Complex.One / (jw - Complex.Conjugate(poles[k]));
                var P = u + v;
                var Q = Complex.ImaginaryOne * (u - v);
                Preal[i, k] = P.Real; Pimag[i, k] = P.Imaginary;
                Qreal[i, k] = Q.Real; Qimag[i, k] = Q.Imaginary;
            }
        }
        var lrR = new double[nf];
        // 下残差列 -1/ω²：f=0 时若下限取 1e-9 会得到 -1e9 的病态元素，主导最小二乘。
        // 改用第一个非零频率对应的 ω² 作下限（全零频率时退回原下限）。
        double wMinSq = 1e-9;
        for (int i = 0; i < nf; i++)
        {
            if (freqs[i] > 0) { wMinSq = Math.Pow(2 * Math.PI * freqs[i], 2); break; }
        }
        for (int i = 0; i < nf; i++)
        {
            double w2 = Math.Max(Math.Pow(2 * Math.PI * freqs[i], 2), wMinSq);
            lrR[i] = -1.0 / w2;
        }

        var psiC = new Complex[nm, np];
        var lowerResidual = new double[np];
        var upperResidual = new double[np];
        var b = MnVector.Build.Dense(2 * nf);

        for (int o = 0; o < np; o++)
        {
            double maxWeight = 1.0;
            if (weights != null)
            {
                maxWeight = 0;
                for (int i = 0; i < nf; i++)
                {
                    double value = weights[i, o];
                    if (double.IsFinite(value) && value > maxWeight) maxWeight = value;
                }
                // 整个通道没有可信频点时，QR(0)=0/0 会返回 NaN。该通道应明确为零振型，
                // 而不是让 NaN 进入归一化、状态点和 3D 振形。
                if (maxWeight <= 1e-15) continue;
            }
            double weightNormalization = 1.0 / Math.Sqrt(maxWeight);
            var Ar = Matrix<double>.Build.Dense(2 * nf, cols);
            for (int i = 0; i < nf; i++)
            {
                double rawWeight = weights == null || !double.IsFinite(weights[i, o])
                    ? (weights == null ? 1.0 : 0.0)
                    : Math.Max(weights[i, o], 0.0);
                double w = Math.Sqrt(rawWeight) * weightNormalization;
                for (int k = 0; k < nm; k++)
                {
                    // 实部方程: a·P.Real + b·Q.Real ; 虚部方程: a·P.Imag + b·Q.Imag（含共轭极点项）
                    Ar[i, 2 * k]          = w * Preal[i, k];
                    Ar[i, 2 * k + 1]      = w * Qreal[i, k];
                    Ar[i + nf, 2 * k]     = w * Pimag[i, k];
                    Ar[i + nf, 2 * k + 1] = w * Qimag[i, k];
                }
                Ar[i, 2 * nm] = w * lrR[i];       Ar[i, 2 * nm + 1] = w * 1.0;
                Ar[i + nf, 2 * nm] = 0;            Ar[i + nf, 2 * nm + 1] = 0;
            }
            for (int i = 0; i < nf; i++)
            {
                double rawWeight = weights == null || !double.IsFinite(weights[i, o])
                    ? (weights == null ? 1.0 : 0.0)
                    : Math.Max(weights[i, o], 0.0);
                double w = Math.Sqrt(rawWeight) * weightNormalization;
                b[i] = w * H[i, o].Real;
                b[i + nf] = w * H[i, o].Imaginary;
            }
            // Thin QR 求最小二乘（内存 O(m·n)）；PseudoInverse 走 SVD 会分配 m×m 的 U，2nf 很大时内存爆炸
            MnVector x;
            try { x = Ar.QR(MathNet.Numerics.LinearAlgebra.Factorization.QRMethod.Thin).Solve(b); }
            catch { continue; }
            if (x.Any(value => !double.IsFinite(value))) continue;
            for (int k = 0; k < nm; k++)
                psiC[k, o] = new Complex(x[2 * k], x[2 * k + 1]);
            lowerResidual[o] = x[2 * nm];
            upperResidual[o] = x[2 * nm + 1];
        }

        // 复 → 实模态
        var psiR = new double[nm, np];
        for (int k = 0; k < nm; k++)
        {
            var v = new Complex[np];
            for (int o = 0; o < np; o++) v[o] = psiC[k, o];
            Complex acc = Complex.Zero;
            for (int o = 0; o < np; o++) acc += v[o] * v[o];
            double phi = 0.5 * acc.Phase;
            double peak = 0;
            var rotated = new double[np];
            for (int o = 0; o < np; o++)
            {
                var r = (v[o] * Complex.FromPolarCoordinates(1.0, -phi)).Real;
                rotated[o] = r;
                if (Math.Abs(r) > peak) peak = Math.Abs(r);
            }
            if (peak > 0) for (int o = 0; o < np; o++) rotated[o] /= peak;
            for (int o = 0; o < np; o++) psiR[k, o] = rotated[o];
        }

        // ─── 异常点抑制（移植自 QuickModal，默认启用 Clip）───
        var outliers = new List<int>[nm];
        for (int k = 0; k < nm; k++) outliers[k] = new List<int>();
        if (outlierOpt != null && outlierOpt.Enabled && nm > 0 && np > 4)
        {
            // 1) 低相干坏点（所有阶共用）
            var globalBad = new HashSet<int>();
            if (outlierOpt.CoherenceFloor > 0 && weights != null)
            {
                int nf2 = weights.GetLength(0);
                for (int o = 0; o < np; o++)
                {
                    double sum = 0;
                    for (int i = 0; i < nf2; i++) sum += weights[i, o];
                    double mean = sum / nf2;
                    if (mean < outlierOpt.CoherenceFloor) globalBad.Add(o);
                }
            }
            // 1b) 用户强制标记的坏点
            if (outlierOpt.ForcedBadIndices != null)
                foreach (var idx in outlierOpt.ForcedBadIndices)
                    if (idx >= 0 && idx < np) globalBad.Add(idx);

            // 2) 逐阶 MAD 检测 + 处理
            for (int k = 0; k < nm; k++)
            {
                var mags = new double[np];
                for (int o = 0; o < np; o++) mags[o] = Math.Abs(psiR[k, o]);
                var sorted = (double[])mags.Clone(); Array.Sort(sorted);
                double median = sorted[np / 2];
                var dev = new double[np];
                for (int o = 0; o < np; o++) dev[o] = Math.Abs(mags[o] - median);
                var devSorted = (double[])dev.Clone(); Array.Sort(devSorted);
                double mad = devSorted[np / 2] * 1.4826;
                if (mad < 1e-9) mad = 1e-9;
                double thr = median + outlierOpt.MadFactor * mad;
                // 振型已归一到 |max|=1：异常点常 |x|=1 而其它点远小 → 判据 >= max(thr, 0.6, 8×中位数)
                double badThr = Math.Max(thr, Math.Max(0.6, 8 * (median + 1e-9)));

                var bad = new List<int>();
                for (int o = 0; o < np; o++)
                    if (globalBad.Contains(o) || mags[o] > badThr) bad.Add(o);
                outliers[k] = bad;
                if (bad.Count == 0) continue;

                switch (outlierOpt.Action)
                {
                    case OutlierAction.None: break;
                    case OutlierAction.Zero:
                        foreach (var o in bad) { psiR[k, o] = 0; psiC[k, o] = Complex.Zero; }
                        break;
                    case OutlierAction.Clip:
                    {
                        double healthyMax = 0;
                        for (int o = 0; o < np; o++)
                            if (!bad.Contains(o) && mags[o] > healthyMax) healthyMax = mags[o];
                        double cap = Math.Max(healthyMax * 1.05, median * 4 + 1e-9);
                        if (cap < 1e-6) cap = 1.0;
                        foreach (var o in bad)
                        {
                            double scale = cap / Math.Max(mags[o], 1e-12);
                            psiR[k, o] *= scale;
                            psiC[k, o] *= scale;
                        }
                        break;
                    }
                    case OutlierAction.Interpolate:
                    {
                        var coords = outlierOpt.Coords;
                        foreach (var o in bad)
                        {
                            int kn = Math.Min(5, np - bad.Count);
                            if (kn <= 0 || coords == null)
                            {
                                psiR[k, o] = 0; psiC[k, o] = Complex.Zero; continue;
                            }
                            var dists = new (int idx, double d)[np];
                            for (int j = 0; j < np; j++)
                            {
                                if (bad.Contains(j) || j == o) { dists[j] = (j, double.MaxValue); continue; }
                                double dx = coords[j, 0] - coords[o, 0];
                                double dy = coords[j, 1] - coords[o, 1];
                                double dz = coords[j, 2] - coords[o, 2];
                                dists[j] = (j, Math.Sqrt(dx * dx + dy * dy + dz * dz));
                            }
                            Array.Sort(dists, (a, b) => a.d.CompareTo(b.d));
                            double sumR = 0; Complex sumC = Complex.Zero;
                            for (int t = 0; t < kn; t++)
                            {
                                sumR += psiR[k, dists[t].idx];
                                sumC += psiC[k, dists[t].idx];
                            }
                            psiR[k, o] = sumR / kn;
                            psiC[k, o] = sumC / kn;
                        }
                        break;
                    }
                }
            }

            // 3) 处理后重新归一化
            for (int k = 0; k < nm; k++)
            {
                double peak = 0;
                for (int o = 0; o < np; o++)
                    if (Math.Abs(psiR[k, o]) > peak) peak = Math.Abs(psiR[k, o]);
                if (peak > 1e-12)
                    for (int o = 0; o < np; o++) psiR[k, o] /= peak;
            }
        }

        return new ModeShapeResult
        {
            Complex = psiC,
            Real = psiR,
            Outliers = outliers,
            LowerResidual = lowerResidual,
            UpperResidual = upperResidual
        };
    }
}
