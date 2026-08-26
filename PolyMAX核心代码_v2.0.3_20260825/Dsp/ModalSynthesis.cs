using System;
using System.Numerics;

namespace NiScope.Dsp;

/// <summary>LSFD 模态综合及拟合质量，供 PolyMAX 自动选模态和验证视图共用。</summary>
public sealed class ModalSynthesisResult
{
    public Complex[,] Synthesized { get; init; } = new Complex[0, 0];
    /// <summary>复数加权相关系数，0..1。</summary>
    public double Correlation { get; init; }
    /// <summary>加权相对 RMS 误差 sqrt(sum(w|H-Hhat|²)/sum(w|H|²))。</summary>
    public double RelativeError { get; init; }
    public double WeightedSse { get; init; }
    public double MeasuredEnergy { get; init; }
    /// <summary>
    /// 固定其它留数时移除该模态造成的 SSE 增量 / 测量能量。
    /// 值越大表示该模态对综合 FRF 的独立贡献越明显。
    /// </summary>
    public double[] ModeContributionFractions { get; init; } = Array.Empty<double>();
}

/// <summary>
/// H(jω)=Σ[r/(jω-p)+conj(r)/(jω-conj(p))]-LR/ω²+UR。
/// 与 <see cref="LsfdEstimator"/> 使用完全相同的共轭极点及 LR/UR 基函数。
/// </summary>
public static class ModalSynthesis
{
    public static ModalSynthesisResult Evaluate(
        double[] frequencies,
        Complex[,] measured,
        Complex[] poles,
        ModeShapeResult fit,
        double[,]? weights = null)
    {
        ArgumentNullException.ThrowIfNull(frequencies);
        ArgumentNullException.ThrowIfNull(measured);
        ArgumentNullException.ThrowIfNull(poles);
        ArgumentNullException.ThrowIfNull(fit);
        int nf = frequencies.Length;
        int np = measured.GetLength(1);
        int nm = poles.Length;
        if (measured.GetLength(0) != nf)
            throw new ArgumentException("measured 行数必须等于频率数。", nameof(measured));
        if (fit.Complex.GetLength(0) != nm || fit.Complex.GetLength(1) != np)
            throw new ArgumentException("LSFD 留数矩阵尺寸必须为 (模态数, 输出数)。", nameof(fit));
        if (fit.LowerResidual.Length != np || fit.UpperResidual.Length != np)
            throw new ArgumentException("LSFD LR/UR 残差长度必须等于输出数。", nameof(fit));
        if (weights != null && (weights.GetLength(0) != nf || weights.GetLength(1) != np))
            throw new ArgumentException("权重矩阵尺寸必须与 measured 一致。", nameof(weights));

        var synthesized = new Complex[nf, np];
        var modalTerms = new Complex[nm, nf, np];
        double wMinSq = FirstNonZeroOmegaSquared(frequencies);
        for (int i = 0; i < nf; i++)
        {
            Complex jw = Complex.ImaginaryOne * (2 * Math.PI * frequencies[i]);
            double omegaSquared = Math.Max(Math.Pow(2 * Math.PI * frequencies[i], 2), wMinSq);
            for (int o = 0; o < np; o++)
            {
                Complex value = -fit.LowerResidual[o] / omegaSquared + fit.UpperResidual[o];
                for (int k = 0; k < nm; k++)
                {
                    Complex residue = fit.Complex[k, o];
                    Complex term = residue / (jw - poles[k])
                                   + Complex.Conjugate(residue) /
                                     (jw - Complex.Conjugate(poles[k]));
                    modalTerms[k, i, o] = term;
                    value += term;
                }
                synthesized[i, o] = value;
            }
        }

        Metrics metrics = ComputeMetrics(measured, synthesized, weights);
        var contributions = new double[nm];
        double denominator = Math.Max(metrics.MeasuredEnergy, 1e-30);
        for (int k = 0; k < nm; k++)
        {
            double sseWithout = 0;
            double usedWeight = 0;
            for (int i = 0; i < nf; i++)
                for (int o = 0; o < np; o++)
                {
                    double weight = EffectiveWeight(weights, i, o);
                    if (weight <= 0) continue;
                    Complex residualWithout = measured[i, o] - synthesized[i, o] + modalTerms[k, i, o];
                    sseWithout += weight * MagnitudeSquared(residualWithout);
                    usedWeight += weight;
                }
            // 相干度全部为零时与总体指标一样退回无权评价。
            if (usedWeight <= 0 && weights != null)
            {
                for (int i = 0; i < nf; i++)
                    for (int o = 0; o < np; o++)
                    {
                        Complex residualWithout = measured[i, o] - synthesized[i, o] + modalTerms[k, i, o];
                        sseWithout += MagnitudeSquared(residualWithout);
                    }
            }
            contributions[k] = Math.Max(0.0, (sseWithout - metrics.WeightedSse) / denominator);
        }

        return new ModalSynthesisResult
        {
            Synthesized = synthesized,
            Correlation = metrics.Correlation,
            RelativeError = metrics.RelativeError,
            WeightedSse = metrics.WeightedSse,
            MeasuredEnergy = metrics.MeasuredEnergy,
            ModeContributionFractions = contributions
        };
    }

    private readonly record struct Metrics(
        double Correlation,
        double RelativeError,
        double WeightedSse,
        double MeasuredEnergy);

    private static Metrics ComputeMetrics(Complex[,] measured, Complex[,] synthesized, double[,]? weights)
    {
        int nf = measured.GetLength(0), np = measured.GetLength(1);
        double measuredEnergy = 0, synthesizedEnergy = 0, sse = 0, usedWeight = 0;
        Complex cross = Complex.Zero;
        void Accumulate(int i, int o, double weight)
        {
            Complex h = measured[i, o];
            Complex hs = synthesized[i, o];
            measuredEnergy += weight * MagnitudeSquared(h);
            synthesizedEnergy += weight * MagnitudeSquared(hs);
            sse += weight * MagnitudeSquared(h - hs);
            cross += weight * Complex.Conjugate(h) * hs;
            usedWeight += weight;
        }

        for (int i = 0; i < nf; i++)
            for (int o = 0; o < np; o++)
            {
                double weight = EffectiveWeight(weights, i, o);
                if (weight > 0) Accumulate(i, o, weight);
            }
        if (usedWeight <= 0 && weights != null)
            for (int i = 0; i < nf; i++)
                for (int o = 0; o < np; o++) Accumulate(i, o, 1.0);

        double corrDenominator = Math.Sqrt(measuredEnergy * synthesizedEnergy);
        double correlation = corrDenominator > 1e-30
            ? Math.Clamp(cross.Magnitude / corrDenominator, 0.0, 1.0)
            : 0.0;
        double relativeError = measuredEnergy > 1e-30
            ? Math.Sqrt(Math.Max(0.0, sse / measuredEnergy))
            : 0.0;
        return new Metrics(correlation, relativeError, sse, measuredEnergy);
    }

    private static double FirstNonZeroOmegaSquared(double[] frequencies)
    {
        foreach (double frequency in frequencies)
            if (frequency > 0) return Math.Pow(2 * Math.PI * frequency, 2);
        return 1e-9;
    }

    private static double EffectiveWeight(double[,]? weights, int i, int o)
    {
        if (weights == null) return 1.0;
        double value = weights[i, o];
        return double.IsFinite(value) ? Math.Max(0.0, value) : 0.0;
    }

    private static double MagnitudeSquared(Complex value) =>
        value.Real * value.Real + value.Imaginary * value.Imaginary;
}
