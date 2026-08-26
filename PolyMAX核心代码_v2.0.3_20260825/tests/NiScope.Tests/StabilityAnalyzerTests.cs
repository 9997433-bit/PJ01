using System.Numerics;
using NiScope.Dsp;
using Xunit;

namespace NiScope.Tests;

public class StabilityAnalyzerTests
{
    [Fact]
    public void Cluster_RequiresConsecutiveModelOrders()
    {
        var levels = new List<List<PoleEntry>>
        {
            new() { Entry(20, 100.0) },
            new() { Entry(24, 100.2) },
            new() { Entry(28, 99.9) },
            new() { Entry(32, 100.1) }
        };
        var opt = new StabilityOptions
        {
            MinStableCount = 4,
            OrderStep = 2,
            ClusterFreqTolHz = 2,
            RequireConsecutiveOrders = true
        };

        Assert.Empty(StabilityAnalyzer.Cluster(levels, opt));

        levels = new List<List<PoleEntry>>
        {
            new() { Entry(20, 100.0) },
            new() { Entry(22, 100.2) },
            new() { Entry(24, 99.9) },
            new() { Entry(26, 100.1) }
        };
        var cluster = Assert.Single(StabilityAnalyzer.Cluster(levels, opt));
        Assert.Equal(4, cluster.ConsecutiveStableCount);
    }

    [Fact]
    public void SelectCmifSupportedModes_KeepsOneModePerResolvablePeak()
    {
        var frequencies = Enumerable.Range(0, 41).Select(i => i * 25.0).ToArray();
        var cmif = frequencies.Select(f =>
            1.0
            + 4.0 * Math.Exp(-Math.Pow((f - 250.0) / 55.0, 2))
            + 3.0 * Math.Exp(-Math.Pow((f - 450.0) / 50.0, 2)))
            .ToArray();
        var clusters = new List<ModeCluster>
        {
            Cluster(209.0, 0.05),
            Cluster(256.0, 0.08),
            Cluster(448.0, 0.06),
            Cluster(460.0, 0.04),
            Cluster(553.0, 0.03),
            Cluster(700.0, 0.03)
        };

        var result = StabilityAnalyzer.SelectCmifSupportedModes(
            clusters, frequencies, cmif, 0, 1000);

        Assert.Equal(25.0, result.FrequencyResolutionHz, 6);
        Assert.Equal(2, result.Modes.Count);
        Assert.Equal(256.0, result.Modes[0].Frequency, 6);
        Assert.Equal(448.0, result.Modes[1].Frequency, 6);
    }

    [Fact]
    public void SelectCmifSupportedModes_RejectsNonPhysicalDamping()
    {
        var frequencies = Enumerable.Range(0, 21).Select(i => i * 5.0).ToArray();
        var cmif = frequencies.Select(f => 1.0 + 5.0 * Math.Exp(-Math.Pow((f - 50.0) / 8.0, 2))).ToArray();
        var clusters = new List<ModeCluster> { Cluster(50.0, 0.35) };

        var result = StabilityAnalyzer.SelectCmifSupportedModes(
            clusters, frequencies, cmif, 0, 100);

        Assert.Empty(result.Modes);
    }

    [Fact]
    public void Cluster_RepresentativePoleMatchesReportedMedianFrequencyAndDamping()
    {
        var levels = new List<List<PoleEntry>>
        {
            new() { Entry(20, 99.8, 0.010) },
            new() { Entry(22, 99.9, 0.040) },
            new() { Entry(24, 100.0, 0.020) },
            new() { Entry(26, 100.1, 0.050) },
            new() { Entry(28, 100.2, 0.030) }
        };
        var opt = new StabilityOptions
        {
            MinStableCount = 5,
            OrderStep = 2,
            ClusterFreqTolHz = 1,
            RequireConsecutiveOrders = true
        };

        ModeCluster cluster = Assert.Single(StabilityAnalyzer.Cluster(levels, opt));

        Assert.Equal(cluster.Frequency, cluster.Pole.Magnitude / (2 * Math.PI), 9);
        Assert.Equal(cluster.Damping, -cluster.Pole.Real / cluster.Pole.Magnitude, 9);
    }

    [Fact]
    public void DensityClustering_SeparatesCloseModesByParticipationVector()
    {
        var orders = new List<PolymaxOrderResult>();
        for (int i = 0; i < 5; i++)
        {
            int order = 20 + 2 * i;
            orders.Add(new PolymaxOrderResult(
                order,
                new[] { Pole(100.0 + 0.03 * i), Pole(100.55 - 0.02 * i) },
                new[]
                {
                    new[] { Complex.One, Complex.Zero },
                    new[] { Complex.Zero, Complex.One }
                }));
        }
        var opt = new StabilityOptions
        {
            MinStableCount = 4,
            OrderStep = 2,
            FreqTolerance = 0.02,
            ClusterFreqTolHz = 1.0,
            ClusterRelativeFreqTolerance = 0,
            ClusterMacThreshold = 0.9,
            RequireConsecutiveOrders = true
        };

        var levels = StabilityAnalyzer.Classify(orders, opt);
        var clusters = StabilityAnalyzer.Cluster(levels, opt);

        Assert.Equal(2, clusters.Count);
        Assert.All(clusters, cluster => Assert.NotNull(cluster.RepresentativeVector));
        Assert.True(Math.Abs(clusters[0].Frequency - clusters[1].Frequency) < 1.0);
    }

    [Fact]
    public void DensityClustering_MergesFragmentedClustersWithSameVector()
    {
        var vector = new[] { Complex.One, new Complex(0.5, 0.2) };
        var levels = new List<List<PoleEntry>>();
        for (int i = 0; i < 6; i++)
        {
            double frequency = i < 3 ? 100.0 + 0.05 * i : 101.5 + 0.05 * (i - 3);
            PoleEntry entry = Entry(20 + 2 * i, frequency);
            entry.Shape = vector;
            levels.Add(new List<PoleEntry> { entry });
        }
        var opt = new StabilityOptions
        {
            MinStableCount = 6,
            OrderStep = 2,
            ClusterFreqTolHz = 1.0,
            ClusterRelativeFreqTolerance = 0,
            ClusterMinPoints = 2,
            MergeFragmentedClusters = true,
            RequireConsecutiveOrders = true
        };

        ModeCluster cluster = Assert.Single(StabilityAnalyzer.Cluster(levels, opt));

        Assert.Equal(6, cluster.ConsecutiveStableCount);
        Assert.NotNull(cluster.RepresentativeVector);
    }

    private static PoleEntry Entry(int order, double frequency, double zeta = 0.02)
    {
        double w = 2 * Math.PI * frequency;
        return new PoleEntry
        {
            Order = order,
            Pole = new Complex(-zeta * w, w * Math.Sqrt(1 - zeta * zeta)),
            StableF = true,
            StableD = true,
            StableV = true
        };
    }

    private static Complex Pole(double frequency, double zeta = 0.02)
    {
        double w = 2 * Math.PI * frequency;
        return new Complex(-zeta * w, w * Math.Sqrt(1 - zeta * zeta));
    }

    private static ModeCluster Cluster(double frequency, double damping) => new()
    {
        Frequency = frequency,
        Damping = damping,
        Pole = Complex.One,
        StableCount = 6,
        ConsecutiveStableCount = 6,
        FullyStableCount = 5
    };
}
