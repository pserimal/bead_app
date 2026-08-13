//! CTC/trie decoding — pure port of `ocr_core.bead_ocr_crnn` (build_code_trie,
//! constrained_decode) and `ocr_core.inference` (_greedy_conf, log-softmax).
//!
//! Logits layout is (T, B, C) row-major: index = t*B*C + b*C + c. CTC blank
//! is class 0. The Python reference for every function is named in the docs.

use std::collections::HashMap;

#[derive(Default)]
pub struct TrieNode {
    pub children: HashMap<char, TrieNode>,
    pub code: Option<String>,
}

/// Prefix tree over the code vocabulary — port of `build_code_trie`.
pub fn build_code_trie(codes: &[String]) -> TrieNode {
    let mut root = TrieNode::default();
    for code in codes {
        let mut node = &mut root;
        for ch in code.chars() {
            node = node.children.entry(ch).or_default();
        }
        node.code = Some(code.clone());
    }
    root
}

/// log_softmax over the class axis of a (T, B, C) buffer — matches
/// `F.log_softmax(logits, dim=2)`.
pub fn log_softmax(logits: &[f32], t: usize, b: usize, c: usize) -> Vec<f32> {
    let mut out = vec![0f32; logits.len()];
    for tb in 0..t * b {
        let base = tb * c;
        let max = logits[base..base + c]
            .iter()
            .cloned()
            .fold(f32::NEG_INFINITY, f32::max);
        let mut sum = 0f32;
        for i in 0..c {
            let e = (logits[base + i] - max).exp();
            out[base + i] = e;
            sum += e;
        }
        for i in 0..c {
            out[base + i] = (out[base + i] / sum).ln();
        }
    }
    out
}

/// Beam-free constrained decode — port of `constrained_decode`.
///
/// Walks the trie top-down at each time step: the best trie child logit is
/// compared against the blank logit (minus `blank_penalty`); blank wins →
/// node kept, no emission. CTC collapse: a repeated character on consecutive
/// frames without an intervening blank emits once and does not advance the
/// trie. Returns `(code, score)` per batch element; the score is the sum of
/// the per-step log-probs of the chosen path.
pub fn constrained_decode(
    log_probs: &[f32],
    t: usize,
    b: usize,
    c: usize,
    trie: &TrieNode,
    char_to_idx: &HashMap<char, usize>,
    blank: usize,
    blank_penalty: f32,
) -> Vec<(String, f32)> {
    struct Path<'a> {
        node: &'a TrieNode,
        score: f32,
        emitted: Vec<char>,
        prev_emitted: bool,
    }
    let mut paths: Vec<Path> = (0..b)
        .map(|_| Path { node: trie, score: 0.0, emitted: Vec::new(), prev_emitted: false })
        .collect();

    for tt in 0..t {
        let step = &log_probs[tt * b * c..(tt + 1) * b * c]; // (B, C)
        let mut next_paths: Vec<Path> = Vec::with_capacity(b);
        for bb in 0..b {
            let p = &paths[bb];
            let node = p.node;
            let mut best_child: Option<(char, &TrieNode)> = None;
            let mut best_score = -1e9f32;
            for (ch, child) in &node.children {
                if let Some(&idx) = char_to_idx.get(ch) {
                    let s = step[bb * c + idx];
                    if s > best_score {
                        best_score = s;
                        best_child = Some((*ch, child));
                    }
                }
            }
            let blank_s = step[bb * c + blank] - blank_penalty;
            match best_child {
                Some((ch, child)) if best_score > blank_s => {
                    if p.emitted.last() == Some(&ch) && p.prev_emitted {
                        // CTC collapse: consecutive identical frames emit once.
                        next_paths.push(Path {
                            node,
                            score: p.score + best_score,
                            emitted: p.emitted.clone(),
                            prev_emitted: true,
                        });
                    } else {
                        // Real character: advance down the trie.
                        let mut emitted = p.emitted.clone();
                        emitted.push(ch);
                        next_paths.push(Path {
                            node: child,
                            score: p.score + best_score,
                            emitted,
                            prev_emitted: true,
                        });
                    }
                }
                _ => {
                    // Blank (or no trie child): keep the node, no emission.
                    next_paths.push(Path {
                        node,
                        score: p.score,
                        emitted: p.emitted.clone(),
                        prev_emitted: false,
                    });
                }
            }
        }
        paths = next_paths;
    }

    paths
        .into_iter()
        .map(|p| {
            let emitted: String = p.emitted.iter().collect();
            (p.node.code.clone().unwrap_or(emitted), p.score)
        })
        .collect()
}

/// Free-path confidence — port of `ocr_core.inference._greedy_conf`.
///
/// Greedy CTC collapse over argmax predictions; confidence = exp(mean of the
/// per-step log-probabilities of the frames that actually emit a character).
/// Returns (codes, confidences) per batch element. `chars` is the checkpoint
/// charset (index → character; index 0 = blank is never emitted).
pub fn greedy_conf(
    log_probs: &[f32],
    t: usize,
    b: usize,
    c: usize,
    chars: &[String],
) -> (Vec<String>, Vec<f32>) {
    let mut codes = Vec::with_capacity(b);
    let mut confs = Vec::with_capacity(b);
    for bb in 0..b {
        let mut emitted: Vec<&str> = Vec::new();
        let mut steps: Vec<f32> = Vec::new();
        let mut prev: i64 = -1;
        for tt in 0..t {
            let base = tt * b * c + bb * c;
            let idx = (0..c)
                .max_by(|&i, &j| log_probs[base + i].total_cmp(&log_probs[base + j]))
                .unwrap();
            if idx == 0 {
                // CTC blank: reset the repeat detector, no emission.
                prev = -1;
                continue;
            }
            if idx as i64 != prev {
                emitted.push(chars[idx].as_str());
                steps.push(log_probs[base + idx]);
            }
            prev = idx as i64;
        }
        let conf = if steps.is_empty() {
            0.0
        } else {
            (steps.iter().sum::<f32>() / steps.len() as f32).exp()
        };
        codes.push(emitted.concat());
        confs.push(conf);
    }
    (codes, confs)
}
