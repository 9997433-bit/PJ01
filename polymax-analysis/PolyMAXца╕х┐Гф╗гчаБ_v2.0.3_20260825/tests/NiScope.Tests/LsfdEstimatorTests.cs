using System.Numerics;
using NiScope.Dsp;
using Xunit;

namespace NiScope.Tests;

public sealed class LsfdEstimatorTests
{
    [Fact]
    public void Estimate_AllZeroWeightChannelProducesFiniteZeroResidue()
    {
        const double frequency = 50.0;
        const double damping = 0.01;
        double wn = 2 * Math.PI * frequency;
        var pole = new Complex(-damping * wn, wn * Math.Sqrt(1 - damping * damping));
        double[] frequencies = Enumerable.Range(0, 401).Select(i => 5.0 + i * 0.25).ToArray();
        var h = new Complex[frequencies.Length, 2];
        var weights = new double[frequencies.Length, 2];
        var residue = new Complex(1.2, -0.4);
        for (int i = 0; i < frequencies.Length; i++)
        {
            Complex s = Complex.ImaginaryOne * 2 * Math.PI * frequencies[i];
            Complex value = residue / (s - pole)
                            + Complex.Conjugate(residue) / (s - Complex.Conjugate(pole));
            h[i, 0] = value;
            h[i, 1] = value * 3;
            weights[i, 0] = 1;
            weights[i, 1] = 0;
        }

        ModeShapeResult result = LsfdEstimator.Estimate(
            frequencies,
            h,
            new[] { pole },
            weights,
            new ShapeOutlierOptions { Enabled = false });

        Assert.True(double.IsFinite(result.Complex[0, 0].Real));
        Assert.True(double.IsFinite(result.Complex[0, 0].Imaginary));
        Assert.Equal(residue.Real, result.Complex[0, 0].Real, 8);
        Assert.Equal(residue.Imaginary, result.Complex[0, 0].Imaginary, 8);
        Assert.Equal(Complex.Zero, result.Complex[0, 1]);
        Assert.True(double.IsFinite(result.Real[0, 1]));
    }
}
