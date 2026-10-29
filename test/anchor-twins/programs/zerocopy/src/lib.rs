// Not a twin: a zero-copy (#[repr(C)], with padding) account and generic argument types, for the generated client's
// zero-copy layouts and generic instantiation (test/client/client-anchor.test.ts).
use anchor_lang::prelude::*;

declare_id!("9si6eTzti7y7PNmSgLGTLVMfH2bj23xtLcemsmYuKrvN");

#[program]
pub mod anchor_zerocopy {
    use super::*;

    pub fn create(ctx: Context<Create>) -> Result<()> {
        ctx.accounts.board.load_init()?.owner = ctx.accounts.owner.key();
        Ok(())
    }

    /// Writes every field from the arguments, so the client can check each offset.
    pub fn set(ctx: Context<Set>, flag: u8, big: u128, small: u16, cells: [u16; 3], x: u32, y: u8, last: u8) -> Result<()> {
        let mut b = ctx.accounts.board.load_mut()?;
        b.flag = flag;
        b.big = big;
        b.small = small;
        b.cells = cells;
        b.inner = Inner { x, y };
        b.last = last;
        Ok(())
    }

    /// Generic argument types: the client instantiates Pair<u64, 2> and Wrap<Pair<u64, 2>>.
    pub fn pairs(_ctx: Context<Nothing>, p: Pair<u64, 2>, w: Wrap<Pair<u64, 2>>, q: Pair<u8, 3>) -> Result<u64> {
        Ok(p.a + p.items[0] + p.items[1] + w.v.a + w.n as u64 + q.a as u64 + q.items[2] as u64)
    }
}

#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct Board {
    pub flag: u8,
    pub big: u128,
    pub small: u16,
    pub owner: Pubkey,
    pub cells: [u16; 3],
    pub inner: Inner,
    pub last: u8,
}

#[zero_copy(unsafe)]
#[repr(C)]
pub struct Inner {
    pub x: u32,
    pub y: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Pair<T, const N: usize> {
    pub a: T,
    pub items: [T; N],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Wrap<T> {
    pub v: T,
    pub n: u32,
}

#[derive(Accounts)]
pub struct Create<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + std::mem::size_of::<Board>(), seeds = [b"board", owner.key().as_ref()], bump)]
    pub board: AccountLoader<'info, Board>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Set<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub board: AccountLoader<'info, Board>,
}

#[derive(Accounts)]
pub struct Nothing {}
