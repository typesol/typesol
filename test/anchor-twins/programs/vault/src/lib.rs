use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("HVWmZ4JYMsvmLQoZMXDcjoat1GHHfC1GsgQjSjbGFGX");

#[program]
pub mod vault {
    use super::*;

    pub fn open(ctx: Context<Open>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.owner = ctx.accounts.owner.key();
        v.bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require_keys_eq!(ctx.accounts.vault.owner, ctx.accounts.owner.key(), VaultError::NotOwner);
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer { from: ctx.accounts.owner.to_account_info(), to: ctx.accounts.vault.to_account_info() },
            ),
            amount,
        )?;
        let v = &mut ctx.accounts.vault;
        v.deposited = v.deposited.checked_add(amount).ok_or(error!(VaultError::Overflow))?;
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require_keys_eq!(ctx.accounts.vault.owner, ctx.accounts.owner.key(), VaultError::NotOwner);
        let info = ctx.accounts.vault.to_account_info();
        let floor = Rent::get()?.minimum_balance(info.data_len());
        let remaining = info.lamports().checked_sub(amount).ok_or(error!(VaultError::Overflow))?;
        require!(remaining >= floor, VaultError::InsufficientFunds);
        **info.try_borrow_mut_lamports()? = remaining;
        let owner = ctx.accounts.owner.to_account_info();
        **owner.try_borrow_mut_lamports()? = owner.lamports().checked_add(amount).ok_or(error!(VaultError::Overflow))?;
        let v = &mut ctx.accounts.vault;
        v.withdrawn = v.withdrawn.checked_add(amount).ok_or(error!(VaultError::Overflow))?;
        Ok(())
    }

    pub fn shut(ctx: Context<Shut>) -> Result<()> {
        require_keys_eq!(ctx.accounts.vault.owner, ctx.accounts.owner.key(), VaultError::NotOwner);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub deposited: u64,
    pub withdrawn: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Open<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Vault::INIT_SPACE, seeds = [b"vault", owner.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Shut<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, close = owner)]
    pub vault: Account<'info, Vault>,
}

#[error_code]
pub enum VaultError {
    #[msg("Only the vault owner can do this")]
    NotOwner,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Withdrawal would dip below the rent-exempt minimum")]
    InsufficientFunds,
    #[msg("arithmetic overflow")]
    Overflow,
}
