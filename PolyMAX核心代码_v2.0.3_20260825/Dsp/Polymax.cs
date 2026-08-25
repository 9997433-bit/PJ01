using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Threading;
using MathNet.Numerics.LinearAlgebra;
using MnVector = MathNet.Numerics.LinearAlgebra.Vector<double>;

namespace NiScope.Dsp;

/// <summary>PolyMAX 权重模式。</summary>
public enum PolymaxWeight { None, Coherence, CoherenceNls }

public class PolymaxOptions
{
    public int MinOrder { get; set; } = 20;
    public int MaxOrder { get; set; } = 80;
    public int OrderStep { get; set; } = 2;
    public int? ProjectionDim { get; set; } = 60;
    /// <summary>
    /// 传入矩阵的解释方式：None 忽略；Coherence 使用 γ²；CoherenceNls 使用
    /// γ²/(1-γ²) 作为正规方程目标权重。传入值始终应为原始平方相干度 0..1。
    /// </summary>
    public PolymaxWeight WeightMode { get; set; } = PolymaxWeight.CoherenceNls;
}

/// <summary>
/// 单个模型阶次的极点结果。PoleVectors 与 Poles 按索引一一对应，表示由 p-LSCF
/// 分子多项式在该极点处求值得到的模态参与向量；它只用于跨阶稳定判据，允许位于固定
/// 输出投影坐标系中，因此不要求与最终 LSFD 振型具有相同的绝对尺度。
/// </summary>
public record PolymaxOrderResult(int Order, Complex[] Poles, Complex[][]? PoleVectors = null);

public class PolymaxResult
{
    public IReadOnlyList<PolymaxOrderResult> Orders { get; set; } = Array.Empty<PolymaxOrderResult>();
    public double Dt { get; set; }
    /// <summary>本次求解是否实际使用了传入的权重。</summary>
    public bool WeightsApplied { get; set; }
    /// <summary>实际使用的输出 SVD 投影维数；null 表示未投影。</summary>
    public int? AppliedProjectionDim { get; set; }
    /// <summary>请求了投影，但因各输出权重不同而跳过，以免改变加权最小二乘目标。</summary>
    public bool ProjectionSkippedForOutputDependentWeights { get; set; }
    /// <summary>识别频带对应的 z 域基弧长 (ω_max − ω_min)·dt（弧度）。</summary>
    public double BasisArcLength { get; set; }
    /// <summary>窄带病态告警：BasisArcLength &lt; 0.5 时置位。此时 z 域基函数在单位圆上
    /// 只扫过一小段弧，各阶基高度线性相关，正规方程严重病态，极点/阻尼可信度低。</summary>
    public bool NarrowBandWarning { get; set; }
}

/// <summary>
/// p-LSCF (PolyMAX) — 单参考 / 多输出 / 实系数。移植自 QuickModal.PolymaxIdentifier。
/// 当前 FRF 数据结构只有一个参考输入维，因此这里是合法的 SIMO 标量公共分母形式，
/// 不是 LMS/Simcenter、DASP 可处理多个独立参考输入的完整 MIMO 右矩阵分式实现。
/// 阶数扫描，每阶用伴随矩阵求根得极点，配合稳定图聚类产生候选模态。
/// </summary>
public static class Polymax
{
    public static PolymaxResult Run(double[] freqs, Complex[,] H, double[,]? weights,
        PolymaxOptions opt, Action<double>? progress = null, CancellationToken ct = default)
    {
        NiScope.Licensing.LicenseGuard.Demand(NiScope.Licensing.Feature.Polymax);
        ArgumentNullException.ThrowIfNull(freqs);
        ArgumentNullException.ThrowIfNull(H);
        ArgumentNullException.ThrowIfNull(opt);
        int nf = freqs.Length;
        int np = H.GetLength(1);
        if (nf == 0 || np == 0)
            return new PolymaxResult();
        if (H.GetLength(0) != nf)
            throw new ArgumentException("H 行数必须等于频率数。");
        if (opt.MinOrder < 1 || opt.MaxOrder < opt.MinOrder)
            throw new ArgumentOutOfRangeException(nameof(opt), "模型阶数必须满足 1 <= MinOrder <= MaxOrder。");
        if (opt.OrderStep <= 0)
            throw new ArgumentOutOfRangeException(nameof(opt), "OrderStep 必须大于 0。");
        if (opt.MaxOrder >= nf)
            throw new ArgumentOutOfRangeException(nameof(opt), "MaxOrder 必须小于识别频点数。");
        if (opt.ProjectionDim is <= 0)
            throw new ArgumentOutOfRangeException(nameof(opt), "ProjectionDim 必须大于 0，或设为 null 关闭投影。");
        for (int i = 0; i < nf; i++)
        {
            if (!double.IsFinite(freqs[i]) || freqs[i] < 0 || (i > 0 && freqs[i] <= freqs[i - 1]))
                throw new ArgumentException("频率轴必须为有限、非负且严格递增的数据。", nameof(freqs));
            for (int o = 0; o < np; o++)
            {
                Complex value = H[i, o];
                if (!double.IsFinite(value.Real) || !double.IsFinite(value.Imaginary))
                    throw new ArgumentException("H 中不能包含 NaN 或 Infinity。", nameof(H));
            }
        }

        bool useWeights = opt.WeightMode != PolymaxWeight.None && weights != null;
        if (weights != null && (weights.GetLength(0) != nf || weights.GetLength(1) != np))
            throw new ArgumentException("权重矩阵尺寸必须与 H 一致。", nameof(weights));
        if (useWeights)
        {
            for (int i = 0; i < nf; i++)
                for (int o = 0; o < np; o++)
                    if (!double.IsFinite(weights![i, o]) || weights[i, o] < 0 || weights[i, o] > 1)
                        throw new ArgumentException("相干度权重必须为 0..1 范围内的有限数。", nameof(weights));
        }

        var Hmat = Matrix<Complex>.Build.Dense(nf, np, (i, j) => H[i, j]);
        var Wmat = !useWeights ? null
                   : Matrix<double>.Build.Dense(nf, np,
                       (i, j) => ObjectiveWeight(weights![i, j], opt.WeightMode));
        int? appliedProjectionDim = null;
        bool projectionSkippedForWeights = false;

        if (opt.ProjectionDim.HasValue)
        {
            int rRequest = opt.ProjectionDim.Value;
            int rMax = Math.Min(nf, np);
            int r = Math.Min(rRequest, rMax);
            if (r > 0 && r < np)
            {
                // 只有当每个频点的所有输出使用相同权重时，输出方向的酉变换才保持
                // Σ_o ||W_o(B_o-H_oA)||² 不变。各测点相干度不同的常见情况不能先投影
                // 再丢掉权重，否则低相干/坏通道会重新主导公共分母。
                if (Wmat != null && !WeightsAreOutputInvariant(Wmat))
                {
                    projectionSkippedForWeights = true;
                }
                else
                {
                    // 实系数 RMFD 只能用“实正交”的输出变换。直接对复 H 做 SVD 会得到复 V，
                    // 令投影后的分子系数变成复数，与下面的实系数正规方程不再等价。
                    // 对 [Re(H); Im(H)] 做实 SVD，得到实 V，再计算 H*V。
                    var stacked = Matrix<double>.Build.Dense(2 * nf, np);
                    for (int i = 0; i < nf; i++)
                    {
                        double rowScale = Wmat == null ? 1.0 : Math.Sqrt(Wmat[i, 0]);
                        for (int o = 0; o < np; o++)
                        {
                            stacked[i, o] = rowScale * Hmat[i, o].Real;
                            stacked[i + nf, o] = rowScale * Hmat[i, o].Imaginary;
                        }
                    }
                    var svd = stacked.Svd(computeVectors: true);
                    var realProjection = svd.VT.Transpose().SubMatrix(0, np, 0, r);
                    var complexProjection = Matrix<Complex>.Build.Dense(np, r,
                        (i, j) => new Complex(realProjection[i, j], 0));
                    Hmat *= complexProjection;
                    if (Wmat != null)
                    {
                        var projectedWeights = Matrix<double>.Build.Dense(nf, r);
                        for (int i = 0; i < nf; i++)
                            for (int o = 0; o < r; o++)
                                projectedWeights[i, o] = Wmat[i, 0];
                        Wmat = projectedWeights;
                    }
                    appliedProjectionDim = r;
                }
            }
        }

        double fmax = freqs[^1];
        if (fmax <= 0 || double.IsNaN(fmax) || double.IsInfinity(fmax))
            return new PolymaxResult();
        double dt = 1.0 / (2.5 * fmax);
        var omega = freqs.Select(f => 2 * Math.PI * f).ToArray();
        // 窄带病态防护：z 域基函数 z^k = e^{-jkωdt} 只在单位圆 (ω_max−ω_min)·dt 的弧段内取值，
        // 弧长过短时各阶基函数几乎线性相关，正规方程病态，识别出的极点与阻尼不可信。
        double basisArcLength = (omega[^1] - omega[0]) * dt;
        bool narrowBandWarning = basisArcLength < 0.5;

        var orderList = new List<int>();
        for (int n = opt.MinOrder; n <= opt.MaxOrder; n += opt.OrderStep)
            orderList.Add(n);

        var orders = new List<PolymaxOrderResult>();
        int done = 0;
        foreach (var n in orderList)
        {
            ct.ThrowIfCancellationRequested();
            var orderResult = SolveOrder(omega, Hmat, Wmat, n, dt, ct);
            orders.Add(new PolymaxOrderResult(n, orderResult.Poles, orderResult.PoleVectors));
            done++;
            progress?.Invoke((double)done / orderList.Count);
        }

        return new PolymaxResult
        {
            Orders = orders,
            Dt = dt,
            WeightsApplied = Wmat != null,
            AppliedProjectionDim = appliedProjectionDim,
            ProjectionSkippedForOutputDependentWeights = projectionSkippedForWeights,
            BasisArcLength = basisArcLength,
            NarrowBandWarning = narrowBandWarning
        };
    }

    private static bool WeightsAreOutputInvariant(Matrix<double> weights)
    {
        for (int i = 0; i < weights.RowCount; i++)
        {
            double reference = weights[i, 0];
            for (int o = 1; o < weights.ColumnCount; o++)
            {
                double tolerance = 1e-12 * Math.Max(1.0, Math.Max(Math.Abs(reference), Math.Abs(weights[i, o])));
                if (Math.Abs(weights[i, o] - reference) > tolerance) return false;
            }
        }
        return true;
    }

    private static double ObjectiveWeight(double coherence, PolymaxWeight mode)
    {
        double gammaSquared = Math.Clamp(coherence, 0.0, 1.0);
        return mode switch
        {
            PolymaxWeight.Coherence => gammaSquared,
            PolymaxWeight.CoherenceNls => Math.Min(
                Math.Min(gammaSquared, 0.99) / Math.Max(1.0 - Math.Min(gammaSquared, 0.99), 0.01),
                100.0),
            _ => 1.0
        };
    }

    private sealed record OrderSolution(Complex[] Poles, Complex[][] PoleVectors);

    private static OrderSolution SolveOrder(double[] omega, Matrix<Complex> H, Matrix<double>? W,
        int n, double dt, CancellationToken ct)
    {
        int nf = omega.Length;
        int no = H.ColumnCount;

        var Omega = Matrix<Complex>.Build.Dense(nf, n + 1);
        for (int i = 0; i < nf; i++)
        {
            var z = Complex.FromPolarCoordinates(1.0, -omega[i] * dt);
            Complex zk = Complex.One;
            for (int k = 0; k <= n; k++)
            {
                Omega[i, k] = zk;
                zk *= z;
            }
        }

        var M = Matrix<double>.Build.Dense(n + 1, n + 1);
        // 保存每个输出的 R/S。公共分母求得后由 beta=-R^-1*S*alpha 恢复分子，
        // 再在每个根处求 B_o(z_p)，得到与 LMS 稳定图“模态参与向量”同类的信息。
        var roByOutput = new Matrix<double>?[no];
        var soByOutput = new Matrix<double>?[no];
        for (int o = 0; o < no; o++)
        {
            ct.ThrowIfCancellationRequested();
            if (W != null)
            {
                double totalWeight = 0;
                for (int i = 0; i < nf; i++) totalWeight += W[i, o];
                if (totalWeight <= 1e-30) continue;
            }
            // 每输出独立的权重对角阵（默认 W = 1），与 QuickModal 一致
            var Wo_Omega = Matrix<Complex>.Build.Dense(nf, n + 1);
            var Wo_HoOmega = Matrix<Complex>.Build.Dense(nf, n + 1);
            for (int i = 0; i < nf; i++)
            {
                double w = W == null ? 1.0 : Math.Sqrt(Math.Max(W[i, o], 0.0));
                var ho = H[i, o];
                for (int k = 0; k <= n; k++)
                {
                    Wo_Omega[i, k] = w * Omega[i, k];
                    Wo_HoOmega[i, k] = w * ho * Omega[i, k];
                }
            }
            var RoComplex = Wo_Omega.ConjugateTranspose() * Wo_Omega;
            var SoComplex = -(Wo_Omega.ConjugateTranspose() * Wo_HoOmega);
            var ToComplex = Wo_HoOmega.ConjugateTranspose() * Wo_HoOmega;

            // 原始 PolyMAX 实系数正规方程（Peeters 等，式 16~21）要求先分别取
            // R=Re(XᴴX)、S=Re(XᴴY)、T=Re(YᴴY)，再消元。旧实现先做复数 Schur
            // 补再取实部，等价于暗中允许每个输出的分子系数为复数，并非声明的实系数模型。
            var Ro = Matrix<double>.Build.Dense(n + 1, n + 1,
                (row, col) => RoComplex[row, col].Real);
            var So = Matrix<double>.Build.Dense(n + 1, n + 1,
                (row, col) => SoComplex[row, col].Real);
            var To = Matrix<double>.Build.Dense(n + 1, n + 1,
                (row, col) => ToComplex[row, col].Real);
            // 正则化用相对量（对角均值 × 1e-10）：绝对 1e-12 在 H 幅值很大时不起作用、很小时又过强
            double tr = 0;
            for (int k = 0; k <= n; k++) tr += Ro[k, k];
            double reg = Math.Max(1e-30, tr / (n + 1) * 1e-10);
            for (int k = 0; k <= n; k++) Ro[k, k] += reg;
            roByOutput[o] = Ro;
            soByOutput[o] = So;
            var RinvS = Ro.LU().Solve(So);
            var contrib = To - So.TransposeThisAndMultiply(RinvS);
            for (int r = 0; r <= n; r++)
                for (int c = 0; c <= n; c++)
                    M[r, c] += contrib[r, c];
        }

        double matrixScale = 0;
        for (int r = 0; r <= n; r++)
            for (int c = 0; c <= n; c++)
            {
                if (!double.IsFinite(M[r, c])) return EmptyOrderSolution();
                matrixScale = Math.Max(matrixScale, Math.Abs(M[r, c]));
            }
        if (matrixScale <= 1e-30) return EmptyOrderSolution();

        // 理论上 M 是实对称半正定矩阵；消除浮点乘加产生的微小非对称，避免求解器放大误差。
        for (int r = 0; r <= n; r++)
            for (int c = r + 1; c <= n; c++)
            {
                double value = 0.5 * (M[r, c] + M[c, r]);
                M[r, c] = value;
                M[c, r] = value;
            }

        var Msub = M.SubMatrix(0, n, 0, n);
        var rhs = -M.SubMatrix(0, n, n, 1).Column(0);
        MnVector alphaRed;
        try { alphaRed = Msub.Solve(rhs); }
        catch { return EmptyOrderSolution(); }
        // MathNet LU 遇奇异矩阵不一定抛异常，可能静默返回 NaN/Inf，需显式检查
        for (int k = 0; k < n; k++)
            if (!double.IsFinite(alphaRed[k]))
                return EmptyOrderSolution();
        var alpha = new double[n + 1];
        for (int k = 0; k < n; k++) alpha[k] = alphaRed[k];
        alpha[n] = 1.0;

        var coeffsHi = new double[n + 1];
        for (int k = 0; k <= n; k++) coeffsHi[k] = alpha[n - k];

        // 每输出分子系数。权重全零或病态的输出保持为零，不让 NaN 污染参与向量。
        var betaByOutput = new double[no][];
        var alphaVector = MnVector.Build.DenseOfArray(alpha);
        for (int o = 0; o < no; o++)
        {
            betaByOutput[o] = new double[n + 1];
            if (roByOutput[o] == null || soByOutput[o] == null) continue;
            try
            {
                var beta = -roByOutput[o]!.LU().Solve(soByOutput[o]! * alphaVector);
                if (beta.All(double.IsFinite))
                    for (int k = 0; k <= n; k++) betaByOutput[o][k] = beta[k];
            }
            catch
            {
                // 单个输出分子失败不应丢掉由其余输出共同确定的公共极点。
            }
        }

        var zRoots = PolyRoots(coeffsHi);
        var accepted = new List<(Complex Pole, Complex[] Vector)>();
        foreach (var z in zRoots)
        {
            if (z.Magnitude < 1e-12) continue;
            var s = -Complex.Log(z) / dt;
            if (s.Real < 0 && s.Imaginary > 0)
            {
                var vector = new Complex[no];
                double normSquared = 0;
                for (int o = 0; o < no; o++)
                {
                    // Horner 计算 B_o(z)=sum(beta_ok*z^k)。连续域留数还差一个对所有
                    // 输出相同的标量 -1/(dt*z*A'(z))，MAC 对该标量不敏感，故可省略。
                    Complex value = Complex.Zero;
                    for (int k = n; k >= 0; k--) value = value * z + betaByOutput[o][k];
                    vector[o] = value;
                    normSquared += value.Real * value.Real + value.Imaginary * value.Imaginary;
                }
                double norm = Math.Sqrt(normSquared);
                if (norm > 1e-30)
                    for (int o = 0; o < no; o++) vector[o] /= norm;
                accepted.Add((s, vector));
            }
        }
        accepted.Sort((a, b) => a.Pole.Imaginary.CompareTo(b.Pole.Imaginary));
        return new OrderSolution(
            accepted.Select(x => x.Pole).ToArray(),
            accepted.Select(x => x.Vector).ToArray());
    }

    private static OrderSolution EmptyOrderSolution() =>
        new(Array.Empty<Complex>(), Array.Empty<Complex[]>());

    private static Complex[] PolyRoots(double[] coeffsHi)
    {
        int n = coeffsHi.Length - 1;
        if (n <= 0 || Math.Abs(coeffsHi[0]) < 1e-30)
            return Array.Empty<Complex>();

        var c = new double[n + 1];
        for (int k = 0; k <= n; k++) c[k] = coeffsHi[k] / coeffsHi[0];

        var C = Matrix<double>.Build.Dense(n, n);
        for (int i = 1; i < n; i++) C[i, i - 1] = 1.0;
        for (int i = 0; i < n; i++) C[i, n - 1] = -c[n - i];

        var evd = C.Evd();
        var roots = new Complex[n];
        for (int i = 0; i < n; i++) roots[i] = evd.EigenValues[i];
        return roots;
    }
}
