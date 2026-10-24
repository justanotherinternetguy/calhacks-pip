//! Check-in typing features and z-score verdict against a personal baseline.
use crate::baseline::{median_of, TypingStats};
use crate::config::{BaselineCfg, ThresholdCfg};
use crate::types::{TypingSample, TypingVerdict};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TypingFeatures {
    pub ik_median_ms: f32,
    pub ik_cv: f32,
    pub backspace_rate: f32,
    /// edit distance / phrase length
    pub edit_ratio: f32,
    pub ms_per_char: f32,
}

pub fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        prev = cur;
    }
    prev[b.len()]
}

fn normalize(s: &str) -> String {
    s.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn features(s: &TypingSample) -> TypingFeatures {
    let mut gaps: Vec<f32> = s.key_times_ms.windows(2).map(|w| w[1].saturating_sub(w[0]) as f32).collect();
    let ik_median = median_of(&mut gaps);
    let ik_cv = if gaps.len() >= 2 {
        let mean = gaps.iter().sum::<f32>() / gaps.len() as f32;
        let var = gaps.iter().map(|g| (g - mean).powi(2)).sum::<f32>() / gaps.len() as f32;
        var.sqrt() / mean.max(1.0)
    } else {
        0.0
    };
    let phrase = normalize(&s.phrase);
    let typed = normalize(&s.typed);
    let plen = phrase.chars().count().max(1) as f32;
    let keys = (s.key_times_ms.len() as f32).max(typed.chars().count() as f32).max(1.0);
    TypingFeatures {
        ik_median_ms: ik_median,
        ik_cv,
        backspace_rate: s.backspaces as f32 / keys,
        edit_ratio: levenshtein(&phrase, &typed) as f32 / plen,
        ms_per_char: s.duration_ms as f32 / plen,
    }
}

fn vals(f: &TypingFeatures) -> [f32; 5] {
    [f.ik_median_ms, f.ik_cv, f.backspace_rate, f.edit_ratio, f.ms_per_char]
}

pub fn learn(stats: &mut TypingStats, cfg: &BaselineCfg, f: &TypingFeatures) {
    for (i, v) in vals(f).iter().enumerate() {
        stats.feats[i].push(*v, cfg.max_samples, cfg.ewma_alpha);
    }
    stats.n += 1;
}

/// z-score (positive = worse than baseline) across features; uses priors until ≥3 practice samples.
pub fn zscore(stats: &TypingStats, cfg: &BaselineCfg, f: &TypingFeatures) -> f32 {
    let p = &cfg.typing_priors;
    let priors = [p.ik_median_ms, p.ik_cv, p.backspace_rate, p.edit_ratio, p.ms_per_char];
    let personal = stats.n >= 3;
    let v = vals(f);
    let mut zs = [0.0f32; 5];
    for i in 0..5 {
        let (m, sd) = if personal {
            (stats.feats[i].median(), stats.feats[i].robust_sd().max(priors[i][1] * 0.3))
        } else {
            (priors[i][0], priors[i][1])
        };
        zs[i] = ((v[i] - m) / sd.max(1e-3)).max(0.0);
    }
    // ms_per_char and ik_median are correlated; weight edit/backspace a bit lower (typos happen)
    let w = [1.0, 1.0, 0.7, 0.7, 0.8];
    let num: f32 = zs.iter().zip(w.iter()).map(|(z, w)| z * w).sum();
    num / 2.0
}

pub fn verdict(stats: &TypingStats, bcfg: &BaselineCfg, tcfg: &ThresholdCfg, s: &TypingSample) -> (TypingVerdict, TypingFeatures) {
    let f = features(s);
    let z = zscore(stats, bcfg, &f);
    if f.edit_ratio > tcfg.typing_max_edit_ratio {
        return (
            TypingVerdict { accepted: false, z_score: z, reason: format!("wrong phrase (edit ratio {:.2})", f.edit_ratio) },
            f,
        );
    }
    if z > tcfg.typing_z_reject {
        return (TypingVerdict { accepted: false, z_score: z, reason: format!("typing far off baseline (z {:.1})", z) }, f);
    }
    (TypingVerdict { accepted: true, z_score: z, reason: "ok".into() }, f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn sample(phrase: &str, typed: &str, gap_ms: u64, jitter: &[i64], backspaces: u32) -> TypingSample {
        let n = typed.chars().count();
        let mut t = 0u64;
        let mut times = Vec::new();
        for i in 0..n {
            times.push(t);
            let j = jitter.get(i % jitter.len().max(1)).copied().unwrap_or(0);
            t = (t as i64 + gap_ms as i64 + j).max(0) as u64;
        }
        TypingSample { phrase: phrase.into(), typed: typed.into(), key_times_ms: times, backspaces, duration_ms: t }
    }

    #[test]
    fn features_basic() {
        let s = sample("blue river stone", "blue river stone", 200, &[0], 0);
        let f = features(&s);
        assert_eq!(f.ik_median_ms, 200.0);
        assert!(f.ik_cv < 1e-3);
        assert_eq!(f.edit_ratio, 0.0);
        assert_eq!(f.backspace_rate, 0.0);
        assert_eq!(levenshtein("kitten", "sitting"), 3);
        let s2 = sample("blue river stone", "blue rivr stne", 200, &[0], 2);
        assert!(features(&s2).edit_ratio > 0.05);
    }

    #[test]
    fn verdict_accepts_normal_rejects_impaired() {
        let cfg = Config::default_v1();
        let mut stats = TypingStats::default();
        for _ in 0..5 {
            let s = sample("blue river stone", "blue river stone", 220, &[-20, 10, 30, -10], 0);
            learn(&mut stats, &cfg.baseline, &features(&s));
        }
        let ok = sample("green lamp door", "green lamp door", 240, &[-10, 20, 0], 0);
        let (v, _) = verdict(&stats, &cfg.baseline, &cfg.thresholds, &ok);
        assert!(v.accepted, "{:?}", v);
        let slow = sample("green lamp door", "green lamp dor", 700, &[-300, 400, 50, -200, 600], 4);
        let (v, _) = verdict(&stats, &cfg.baseline, &cfg.thresholds, &slow);
        assert!(!v.accepted && v.z_score > cfg.thresholds.typing_z_reject, "{:?}", v);
        let wrong = sample("green lamp door", "purple hat", 240, &[0], 0);
        let (v, _) = verdict(&stats, &cfg.baseline, &cfg.thresholds, &wrong);
        assert!(!v.accepted && v.reason.contains("wrong phrase"));
    }
}
