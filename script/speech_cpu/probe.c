/* Baseline CPU/OS feature probe. Never execute AVX before checking OSXSAVE. */
#include <stdio.h>
#if defined(_MSC_VER) && defined(_M_X64)
#include <intrin.h>
static int supported(void) {
    int r[4]; __cpuid(r, 0); if (r[0] < 7) return 0;
    __cpuidex(r, 1, 0);
    const unsigned required = (1u<<20)|(1u<<12)|(1u<<27)|(1u<<28)|(1u<<29);
    if (((unsigned)r[2] & required) != required) return 0;
    if ((_xgetbv(0) & 6) != 6) return 0;
    __cpuidex(r, 7, 0); return (r[1] & ((1<<5)|(1<<8))) == ((1<<5)|(1<<8));
}
#elif defined(__x86_64__)
static int supported(void) {
    __builtin_cpu_init();
    return __builtin_cpu_supports("avx2") && __builtin_cpu_supports("fma") &&
           __builtin_cpu_supports("f16c") && __builtin_cpu_supports("bmi2") &&
           __builtin_cpu_supports("sse4.2");
}
#else
static int supported(void) { return 0; }
#endif
int main(void) { puts(supported() ? "avx2" : "baseline"); return 0; }
