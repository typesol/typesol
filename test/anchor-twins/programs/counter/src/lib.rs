use anchor_lang::prelude::*;

declare_id!("EqGyjYr2RHtEV5zQXCPpZ8neqU9tMgmruvuJRW4Pz2aN");

#[program]
pub mod counter {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let c = &mut ctx.accounts.counter;
        c.authority = ctx.accounts.authority.key();
        c.count = 0;
        c.bump = ctx.bumps.counter;
        Ok(())
    }

    pub fn increment(ctx: Context<Increment>, by: u64) -> Result<()> {
        let c = &mut ctx.accounts.counter;
        require_keys_eq!(c.authority, ctx.accounts.authority.key(), CounterError::Unauthorized);
        c.count = c.count.checked_add(by).ok_or(error!(CounterError::Overflow))?;
        Ok(())
    }

    pub fn assert_at_least(ctx: Context<AssertAtLeast>, min: u64) -> Result<()> {
        require!(ctx.accounts.counter.count >= min, CounterError::BelowMinimum);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Counter {
    pub authority: Pubkey,
    pub count: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Counter::INIT_SPACE, seeds = [b"counter", authority.key().as_ref()], bump)]
    pub counter: Account<'info, Counter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Increment<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub counter: Account<'info, Counter>,
}

#[derive(Accounts)]
pub struct AssertAtLeast<'info> {
    pub counter: Account<'info, Counter>,
}

#[error_code]
pub enum CounterError {
    #[msg("Only the counter's authority can change it")]
    Unauthorized,
    #[msg("counter is below the expected minimum")]
    BelowMinimum,
    #[msg("arithmetic overflow")]
    Overflow,
}
