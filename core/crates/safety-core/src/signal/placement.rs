//! Placement inference (pocket / hand / bag) from gravity orientation and variance.
//! Device frame: x right, y up (long axis), z out of the screen.
use super::GaitFeatures;
use crate::types::Placement;

pub fn infer_placement(f: &GaitFeatures, screen_on: bool) -> Placement {
    let [_gx, gy, gz] = f.gravity;
    let upright = gy.abs() > 0.8; // long axis vertical → trouser pocket
    let flat = gz.abs() > 0.85; // screen up/down → table or bag
    let tilted = gz.abs() > 0.3 && gz.abs() <= 0.85;
    if screen_on && (tilted || flat) {
        return Placement::Hand;
    }
    if upright && f.energy_rms > 0.03 {
        return Placement::Pocket;
    }
    if tilted {
        return Placement::Hand;
    }
    if flat && f.energy_rms > 0.03 {
        return Placement::Bag;
    }
    if f.energy_rms <= 0.03 {
        return Placement::Unknown; // resting somewhere; nothing to learn from
    }
    Placement::Bag
}

/// Majority vote over recent placements for stability.
pub struct PlacementVoter {
    recent: Vec<Placement>,
}
impl PlacementVoter {
    pub fn new() -> Self {
        PlacementVoter { recent: Vec::new() }
    }
    pub fn push(&mut self, p: Placement) -> Placement {
        self.recent.push(p);
        if self.recent.len() > 5 {
            self.recent.remove(0);
        }
        let mut counts = [0usize; 4];
        for r in &self.recent {
            counts[r.index()] += 1;
        }
        let best = (0..4).max_by_key(|i| counts[*i]).unwrap_or(0);
        match best {
            1 => Placement::Pocket,
            2 => Placement::Hand,
            3 => Placement::Bag,
            _ => Placement::Unknown,
        }
    }
}
impl Default for PlacementVoter {
    fn default() -> Self {
        Self::new()
    }
}
