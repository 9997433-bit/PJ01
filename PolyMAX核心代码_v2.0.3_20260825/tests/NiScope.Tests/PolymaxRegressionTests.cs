using System.Numerics;
using NiScope.Dsp;
using Xunit;

namespace NiScope.Tests;

/// <summary>
/// PolyMAX/p-LSCF 数值回归：使用已知连续极点合成 SIMO 频响，防止算法在重构时
/// 仍能“画出稳定图”却把频率或阻尼识别错。
/// </summary>
public sealed class PolymaxRegressionTests
{
    [Fact]
    public void Run_RecoversTwoKnownModesFromNoiseFreeSimoFrfs()
    {
        const double f1 = 50.0;
        const double zeta1 = 0.010;
        const double f2 = 120.0;
        const double zeta2 = 0.020;

        double[] frequencies = Enumerable.Range(0, 801)
            .Select(i => 5.0 + i * 0.25)
            .ToArray();

        Complex[,] h = BuildContinuousSimoFrfs(
            frequencies,
            new[] { (f1, zeta1), (f2, zeta2) },
            outputCount: 4);

        PolymaxResult result = Polymax.Run(
            frequencies,
            h,
            weights: null,
            new PolymaxOptions
            {
                MinOrder = 4,
                MaxOrder = 16,
                OrderStep = 2,
                ProjectionDim = null,
                WeightMode = PolymaxWeight.None
            });

        Assert.False(result.WeightsApplied);

        Assert.NotEmpty(result.Orders);
        foreach (PolymaxOrderResult order in result.Orders.Where(x => x.Order >= 8))
        {
            Assert.NotNull(order.PoleVectors);
            Assert.Equal(order.Poles.Length, order.PoleVectors!.Length);
            Assert.All(order.PoleVectors, vector => Assert.Equal(4, vector.Length));
            Complex p1 = ClosestPositivePole(order.Poles, f1);
            Complex p2 = ClosestPositivePole(order.Poles, f2);

            Assert.InRange(PoleFrequency(p1), f1 - 0.5, f1 + 0.5);
            Assert.InRange(PoleFrequency(p2), f2 - 0.8, f2 + 0.8);
            Assert.InRange(PoleDamping(p1), zeta1 - 0.004, zeta1 + 0.004);
            Assert.InRange(PoleDamping(p2), zeta2 - 0.006, zeta2 + 0.006);
        }
    }

    [Fact]
    public void StabilityPipeline_SelectsOnlyTheTwoSupportedModesWithSmallNoise()
    {
        double[] frequencies = Enumerable.Range(0, 801)
            .Select(i => 5.0 + i * 0.25)
            .ToArray();
        Complex[,] h = BuildContinuousSimoFrfs(
            frequencies,
            new[] { (50.0, 0.010), (120.0, 0.020) },
            outputCount: 6,
            relativeNoise: 0.0015);

        PolymaxResult result = Polymax.Run(
            frequencies,
            h,
            weights: null,
            new PolymaxOptions
            {
                MinOrder = 4,
                MaxOrder = 20,
                OrderStep = 2,
                ProjectionDim = null,
                WeightMode = PolymaxWeight.None
            });

        var stability = new StabilityOptions
        {
            FreqTolerance = 0.01,
            DampingTolerance = 0.10,
            MacThreshold = 0.95,
            ClusterFreqTolHz = 1.0,
            MinStableCount = 3,
            OrderStep = 2,
            RequireConsecutiveOrders = true,
            RequireVectorStable = true
        };
        List<List<PoleEntry>> levels = StabilityAnalyzer.Classify(
            result.Orders,
            stability,
            pole => EstimatePoleShape(frequencies, h, pole));
        List<ModeCluster> clusters = StabilityAnalyzer.Cluster(levels, stability);
        var frf = new FrfResult
        {
            Frequencies = frequencies,
            H = h,
            Coherence = CreateOnes(frequencies.Length, h.GetLength(1))
        };
        double[] cmif = ModalPeakPick.Cmif(frf);
        CmifModeSelectionResult selected = StabilityAnalyzer.SelectCmifSupportedModes(
            clusters,
            frequencies,
            cmif,
            5.0,
            205.0,
            minProminenceDb: 0.15);

        Assert.Equal(2, selected.Modes.Count);
        Assert.InRange(selected.Modes[0].Frequency, 49.0, 51.0);
        Assert.InRange(selected.Modes[1].Frequency, 118.5, 121.5);
    }

    [Fact]
    public void Run_SeparatesTwoCloseModesWhenFrequencyResolutionIsSufficient()
    {
        double[] frequencies = Enumerable.Range(0, 601)
            .Select(i => 40.0 + i * 0.05)
            .ToArray();
        Complex[,] h = BuildContinuousSimoFrfs(
            frequencies,
            new[] { (50.0, 0.003), (54.0, 0.004) },
            outputCount: 8);

        PolymaxResult result = Polymax.Run(
            frequencies,
            h,
            weights: null,
            new PolymaxOptions
            {
                MinOrder = 6,
                MaxOrder = 18,
                OrderStep = 2,
                ProjectionDim = null,
                WeightMode = PolymaxWeight.None
            });

        foreach (PolymaxOrderResult order in result.Orders.Where(x => x.Order >= 10))
        {
            Assert.InRange(PoleFrequency(ClosestPositivePole(order.Poles, 50.0)), 49.7, 50.3);
            Assert.InRange(PoleFrequency(ClosestPositivePole(order.Poles, 54.0)), 53.7, 54.3);
        }
    }

    [Fact]
    public void Run_WeightModeNoneIgnoresProvidedWeights()
    {
        double[] frequencies = Enumerable.Range(0, 601)
            .Select(i => 5.0 + i * 0.25)
            .ToArray();
        Complex[,] h = BuildContinuousSimoFrfs(
            frequencies,
            new[] { (50.0, 0.010), (120.0, 0.020) },
            outputCount: 4,
            relativeNoise: 0.001);
        var zeroWeights = new double[frequencies.Length, h.GetLength(1)];

        PolymaxResult result = Polymax.Run(
            frequencies,
            h,
            zeroWeights,
            new PolymaxOptions
            {
                MinOrder = 8,
                MaxOrder = 12,
                OrderStep = 2,
                ProjectionDim = null,
                WeightMode = PolymaxWeight.None
            });

        Assert.False(result.WeightsApplied);

        foreach (PolymaxOrderResult order in result.Orders)
        {
            Assert.InRange(PoleFrequency(ClosestPositivePole(order.Poles, 50.0)), 49.5, 50.5);
            Assert.InRange(PoleFrequency(ClosestPositivePole(order.Poles, 120.0)), 119.0, 121.0);
        }
    }

    [Fact]
    public void Run_CoherenceWeightsRemainEffectiveWhenProjectionWasRequested()
    {
        double[] frequencies = Enumerable.Range(0, 801)
            .Select(i => 5.0 + i * 0.25)
            .ToArray();
        Complex[,] wanted = BuildContinuousSimoFrfs(
            frequencies,
            new[] { (50.0, 0.010), (120.0, 0.020) },
            outputCount: 4,
            relativeNoise: 0.0005);
        Complex[,] interference = BuildContinuousSimoFrfs(
            frequencies,
            new[] { (75.0, 0.008), (155.0, 0.015) },
            outputCount: 16,
            relativeNoise: 0.0005);

        var h = new Complex[frequencies.Length, 20];
        var weights = new double[frequencies.Length, 20];
        for (int i = 0; i < frequencies.Length; i++)
        {
            for (int o = 0; o < 4; o++)
            {
                h[i, o] = wanted[i, o];
                weights[i, o] = 1.0;
            }
            for (int o = 0; o < 16; o++)
            {
                // 大幅值、零相干的干扰通道不应在投影时重新进入公共分母估计。
                h[i, o + 4] = interference[i, o] * 100.0;
                weights[i, o + 4] = 0.0;
            }
        }

        PolymaxResult result = Polymax.Run(
            frequencies,
            h,
            weights,
            new PolymaxOptions
            {
                MinOrder = 8,
                MaxOrder = 14,
                OrderStep = 2,
                ProjectionDim = 2,
                WeightMode = PolymaxWeight.CoherenceNls
            });

        Assert.True(result.WeightsApplied);
        Assert.True(result.ProjectionSkippedForOutputDependentWeights);
        Assert.Null(result.AppliedProjectionDim);

        foreach (PolymaxOrderResult order in result.Orders.Where(x => x.Order >= 10))
        {
            Assert.InRange(PoleFrequency(ClosestPositivePole(order.Poles, 50.0)), 49.5, 50.5);
            Assert.InRange(PoleFrequency(ClosestPositivePole(order.Poles, 120.0)), 119.0, 121.0);
        }
    }

    [Fact]
    public void Run_RealCoefficientNormalEquationsKeepPhysicalPoleInNoisySingleReferenceCase()
    {
        const double targetFrequency = 60.0;
        const double targetDamping = 0.010;
        double[] frequencies = Enumerable.Range(0, 560)
            .Select(i => 20.0 + i * 0.25)
            .ToArray();
        var h = new Complex[frequencies.Length, 4];
        double wn = 2 * Math.PI * targetFrequency;
        var pole = new Complex(
            -targetDamping * wn,
            wn * Math.Sqrt(1 - targetDamping * targetDamping));
        for (int i = 0; i < frequencies.Length; i++)
        {
            Complex s = Complex.ImaginaryOne * 2 * Math.PI * frequencies[i];
            for (int o = 0; o < 4; o++)
            {
                double phase = 0.37 * o;
                Complex residue = Complex.FromPolarCoordinates(0.2 * (1 + 0.2 * o), phase);
                Complex value = new(0.002 * (o + 1), 0.001);
                value += residue / (s - pole)
                         + Complex.Conjugate(residue) / (s - Complex.Conjugate(pole));
                double scale = Math.Max(value.Magnitude, 0.01) * 0.2;
                value += new Complex(
                    Math.Sin(i * (1.731 + 0.07 * o) + phase) * scale,
                    Math.Cos(i * (2.117 + 0.03 * o) - phase) * scale);
                h[i, o] = value;
            }
        }

        PolymaxOrderResult order = Assert.Single(Polymax.Run(
            frequencies,
            h,
            null,
            new PolymaxOptions
            {
                MinOrder = 6,
                MaxOrder = 6,
                OrderStep = 2,
                ProjectionDim = null,
                WeightMode = PolymaxWeight.None
            }).Orders);

        Complex identified = ClosestPositivePole(order.Poles, targetFrequency);
        Assert.InRange(PoleFrequency(identified), 59.0, 61.0);
        Assert.InRange(PoleDamping(identified), 0.0, 0.03);
    }

    [Fact]
    public void Run_UnweightedRealOutputProjectionPreservesKnownModes()
    {
        double[] frequencies = Enumerable.Range(0, 801)
            .Select(i => 5.0 + i * 0.25)
            .ToArray();
        Complex[,] h = BuildContinuousSimoFrfs(
            frequencies,
            new[] { (50.0, 0.010), (120.0, 0.020) },
            outputCount: 12,
            relativeNoise: 0.001);

        PolymaxResult result = Polymax.Run(
            frequencies,
            h,
            null,
            new PolymaxOptions
            {
                MinOrder = 8,
                MaxOrder = 14,
                OrderStep = 2,
                ProjectionDim = 4,
                WeightMode = PolymaxWeight.None
            });

        Assert.Equal(4, result.AppliedProjectionDim);
        foreach (PolymaxOrderResult order in result.Orders.Where(x => x.Order >= 10))
        {
            Assert.InRange(PoleFrequency(ClosestPositivePole(order.Poles, 50.0)), 49.5, 50.5);
            Assert.InRange(PoleFrequency(ClosestPositivePole(order.Poles, 120.0)), 119.0, 121.0);
        }
    }

    [Fact]
    public void Run_RejectsInvalidOrderStepAndMismatchedWeightShape()
    {
        double[] frequencies = Enumerable.Range(0, 20).Select(i => 5.0 + i).ToArray();
        var h = new Complex[frequencies.Length, 2];

        Assert.Throws<ArgumentOutOfRangeException>(() => Polymax.Run(
            frequencies,
            h,
            null,
            new PolymaxOptions { MinOrder = 2, MaxOrder = 4, OrderStep = 0 }));

        Assert.Throws<ArgumentException>(() => Polymax.Run(
            frequencies,
            h,
            new double[frequencies.Length, 1],
            new PolymaxOptions
            {
                MinOrder = 2,
                MaxOrder = 4,
                OrderStep = 2,
                WeightMode = PolymaxWeight.Coherence
            }));
    }

    private static Complex[,] BuildContinuousSimoFrfs(
        IReadOnlyList<double> frequencies,
        IReadOnlyList<(double Frequency, double Damping)> modes,
        int outputCount,
        double relativeNoise = 0)
    {
        var random = new Random(20260803);
        var result = new Complex[frequencies.Count, outputCount];
        for (int i = 0; i < frequencies.Count; i++)
        {
            Complex s = Complex.ImaginaryOne * 2.0 * Math.PI * frequencies[i];
            for (int output = 0; output < outputCount; output++)
            {
                Complex value = new(0.002 * (output + 1), 0);
                for (int mode = 0; mode < modes.Count; mode++)
                {
                    (double frequency, double damping) = modes[mode];
                    double wn = 2.0 * Math.PI * frequency;
                    double wd = wn * Math.Sqrt(1.0 - damping * damping);
                    Complex pole = new(-damping * wn, wd);
                    Complex residue = Complex.FromPolarCoordinates(
                        1.0 + 0.35 * output + 0.2 * mode,
                        0.31 * output - 0.22 * mode);
                    value += residue / (s - pole)
                             + Complex.Conjugate(residue) / (s - Complex.Conjugate(pole));
                }
                if (relativeNoise > 0)
                {
                    double scale = Math.Max(value.Magnitude, 0.01) * relativeNoise;
                    value += new Complex(
                        (random.NextDouble() * 2.0 - 1.0) * scale,
                        (random.NextDouble() * 2.0 - 1.0) * scale);
                }
                result[i, output] = value;
            }
        }
        return result;
    }

    private static Complex ClosestPositivePole(IEnumerable<Complex> poles, double targetFrequency)
        => poles
            .Where(p => p.Real < 0 && p.Imaginary > 0)
            .OrderBy(p => Math.Abs(PoleFrequency(p) - targetFrequency))
            .First();

    private static double PoleFrequency(Complex pole) => pole.Magnitude / (2.0 * Math.PI);

    private static double PoleDamping(Complex pole) => -pole.Real / pole.Magnitude;

    private static Complex[] EstimatePoleShape(double[] frequencies, Complex[,] h, Complex pole)
    {
        int outputs = h.GetLength(1);
        var shape = new Complex[outputs];
        for (int output = 0; output < outputs; output++)
        {
            Complex numerator = Complex.Zero;
            double denominator = 0;
            for (int i = 0; i < frequencies.Length; i++)
            {
                Complex basis = Complex.One
                                / (Complex.ImaginaryOne * 2.0 * Math.PI * frequencies[i] - pole);
                numerator += Complex.Conjugate(basis) * h[i, output];
                denominator += basis.Magnitude * basis.Magnitude;
            }
            shape[output] = denominator > 1e-30 ? numerator / denominator : Complex.Zero;
        }
        return shape;
    }

    private static double[,] CreateOnes(int rows, int columns)
    {
        var result = new double[rows, columns];
        for (int i = 0; i < rows; i++)
            for (int j = 0; j < columns; j++)
                result[i, j] = 1.0;
        return result;
    }
}
