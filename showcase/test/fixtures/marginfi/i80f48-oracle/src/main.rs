// Vectors for every I80F48 operation Marginfi uses, from fixed 1.28.0 itself.
use fixed::types::I80F48;
use std::io::Write;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    fn i128(&mut self) -> i128 {
        let raw = ((self.next() as u128) << 64 | self.next() as u128) as i128;
        // Magnitudes spread over the whole range: shift right by 0..127 bits.
        let shift = (self.next() % 128) as u32;
        let v = raw >> shift;
        match self.next() % 16 {
            0 => 0,
            1 => i128::MAX,
            2 => i128::MIN,
            3 => (self.next() as i128 % 1000) << 48,          // small integers
            4 => -((self.next() as i128 % 1000) << 48),
            5 => (self.next() as i128) & ((1 << 48) - 1),       // fractions only
            6 => -((self.next() as i128) & ((1 << 48) - 1)),
            _ => v,
        }
    }
}
fn o<T: std::fmt::Display>(v: Option<T>) -> String { v.map(|x| format!("\"{}\"", x)).unwrap_or("null".into()) }
fn b(v: Option<I80F48>) -> String { o(v.map(|x| x.to_bits())) }

fn main() {
    let n: usize = std::env::args().nth(1).map(|s| s.parse().unwrap()).unwrap_or(20000);
    let mut r = Rng(0x9e3779b97f4a7c15);
    let out = std::io::stdout();
    let mut w = std::io::BufWriter::new(out.lock());
    for _ in 0..n {
        let (x, y) = (I80F48::from_bits(r.i128()), I80F48::from_bits(r.i128()));
        let f = x.to_num::<f64>();
        writeln!(w, "{{\"a\":\"{}\",\"b\":\"{}\",\"add\":{},\"sub\":{},\"mul\":{},\"div\":{},\"sadd\":\"{}\",\"ssub\":\"{}\",\"smul\":\"{}\",\"wadd\":\"{}\",\"abs\":{},\"uabs\":\"{}\",\"int\":\"{}\",\"frac\":\"{}\",\"floor\":{},\"ceil\":{},\"round\":{},\"f64\":\"{}\",\"u64\":{},\"u32\":{},\"i64\":{},\"i128\":{}}}",
            x.to_bits(), y.to_bits(),
            b(x.checked_add(y)), b(x.checked_sub(y)), b(x.checked_mul(y)), b(x.checked_div(y)),
            x.saturating_add(y).to_bits(), x.saturating_sub(y).to_bits(), x.saturating_mul(y).to_bits(), x.wrapping_add(y).to_bits(),
            b(x.checked_abs()), x.unsigned_abs().to_bits(), x.int().to_bits(), x.frac().to_bits(),
            b(x.checked_floor()), b(x.checked_ceil()), b(x.checked_round()),
            f.to_bits(),
            o(x.checked_to_num::<u64>()), o(x.checked_to_num::<u32>()), o(x.checked_to_num::<i64>()), o(x.checked_to_num::<i128>()),
        ).unwrap();
    }
}
