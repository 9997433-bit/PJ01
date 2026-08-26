using System.Numerics;
using NiScope.Dsp;
using Xunit;

namespace NiScope.Tests;

public sealed class ModalSynthesisTests
{
    [Fact]
    public void LsfdAndSynthesis_ReconstructNoiseFreeFrfIncludingResiduals()
    {
        double[] frequencies = Enumerable.Range(0, 600).Select(i => 5.0 + i * 0.25).ToArray();
        Complex[] poles = { Pole(42.0, 0.012), Pole(96.0, 0.018) };
        var residues = new[,]
        {
            { new Complex(1.1, -0.3), new Complex(-0.4, 0.8) },
            { new Complex(0.7, 0.5), new Complex(1.3, -0.2) }
        };
        double[] lr = { 2.5, -1.2 };
        double[] ur = { 0.015, -0.008 };
        Complex[,] measured = Synthesize(frequencies, poles, residues, lr, ur);

        ModeShapeResult fit = LsfdEstimator.Estimate(
            frequencies, measured, poles, null, new ShapeOutlierOptions { Enabled = false });
        ModalSynthesisResult result = ModalSynthesis.Evaluate(
            frequencies, measured, poles, fit);

        Assert.InRange(result.Correlation, 0.999999999, 1.0);
        Assert.InRange(result.RelativeError, 0.0, 1e-8);
        Assert.All(result.ModeContributionFractions, value => Assert.True(value > 1e-6));
    }

    [Fact]
    public void Evaluate_ReportsZeroContributionForZeroResiduePole()
    {
        double[] frequencies = Enumerable.Range(0, 401).Select(i => 10.0 + i * 0.25).ToArray();
        Complex[] poles = { Pole(50.0, 0.01), Pole(78.0, 0.015) };
        var fit = new ModeShapeResult
        {
            Complex = new[,]
            {
                { new Complex(1.0, 0.25) },
                { Complex.Zero }
            },
            Real = new double[2, 1],
            Outliers = new[] { new List<int>(), new List<int>() },
            LowerResidual = new[] { 0.0 },
            UpperResidual = new[] { 0.0 }
        };
        Complex[,] measured = Synthesize(
            frequencies, poles, fit.Complex, fit.LowerResidual, fit.UpperResidual);

        ModalSynthesisResult result = ModalSynthesis.Evaluate(
            frequencies, measured, poles, fit);

        Assert.True(result.ModeContributionFractions[0] > 0.1);
        Assert.Equal(0.0, result.ModeContributionFractions[1], 12);
        Assert.Equal(0.0, result.RelativeError, 12);
    }

    private static Complex[,] Synthesize(
        double[] frequencies,
        Complex[] poles,
        Complex[,] residues,
        double[] lowerResidual,
        double[] upperResidual)
    {
        int nf = frequencies.Length, np = residues.GetLength(1);
        var h = new Complex[nf, np];
        double wMinSquared = Math.Pow(2 * Math.PI * frequencies.First(f => f > 0), 2);
        for (int i = 0; i < nf; i++)
        {
            Complex jw = Complex.ImaginaryOne * 2 * Math.PI * frequencies[i];
            double w2 = Math.Max(Math.Pow(2 * Math.PI * frequencies[i], 2), wMinSquared);
            for (int o = 0; o < np; o++)
            {
                Complex value = -lowerResidual[o] / w2 + upperResidual[o];
                for (int k = 0; k < poles.Length; k++)
                    value += residues[k, o] / (jw - poles[k])
                             + Complex.Conjugate(residues[k, o]) /
                               (jw - Complex.Conjugate(poles[k]));
                h[i, o] = value;
            }
        }
        return h;
    }

    private static Complex Pole(double frequency, double zeta)
    {
        double w = 2 * Math.PI * frequency;
        return new Complex(-zeta * w, w * Math.Sqrt(1 - zeta * zeta));
    }
}
