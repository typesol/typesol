use anchor_lang::prelude::*;
use anchor_spl::token::{close_account, transfer, CloseAccount, Token, TokenAccount, Transfer};

declare_id!("aHbra6ogev5FhFznpsWa1obufi5NkUkHtkGw5hJNuPW");

#[program]
pub mod escrow {
    use super::*;

    pub fn make(ctx: Context<Make>, seed: u64, amount_a: u64, want_b: u64, mint_b: Pubkey) -> Result<()> {
        require!(amount_a > 0 && want_b > 0, EscrowError::ZeroAmount);
        let offer_key = ctx.accounts.offer.key();
        let vault = &ctx.accounts.vault;
        require!(
            vault.owner == offer_key && vault.mint == ctx.accounts.maker_token_a.mint && vault.amount == 0,
            EscrowError::BadVault
        );
        transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.maker_token_a.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                },
            ),
            amount_a,
        )?;
        let o = &mut ctx.accounts.offer;
        o.maker = ctx.accounts.maker.key();
        o.mint_a = ctx.accounts.maker_token_a.mint;
        o.mint_b = mint_b;
        o.vault = ctx.accounts.vault.key();
        o.amount_a = amount_a;
        o.want_b = want_b;
        o.seed = seed;
        o.bump = ctx.bumps.offer;
        Ok(())
    }

    pub fn take(ctx: Context<Take>) -> Result<()> {
        let o = &ctx.accounts.offer;
        require_keys_eq!(o.maker, ctx.accounts.maker.key(), EscrowError::WrongMaker);
        require_keys_eq!(o.vault, ctx.accounts.vault.key(), EscrowError::WrongVault);
        require!(
            ctx.accounts.taker_token_a.mint == o.mint_a && ctx.accounts.taker_token_b.mint == o.mint_b,
            EscrowError::WrongMint
        );
        require!(ctx.accounts.maker_token_b.mint == o.mint_b, EscrowError::WrongMint);
        require_keys_eq!(ctx.accounts.maker_token_b.owner, o.maker, EscrowError::WrongRecipient);

        let tp = ctx.accounts.token_program.key();
        transfer(
            CpiContext::new(
                tp,
                Transfer {
                    from: ctx.accounts.taker_token_b.to_account_info(),
                    to: ctx.accounts.maker_token_b.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            o.want_b,
        )?;
        let seed = o.seed.to_le_bytes();
        let seeds: &[&[u8]] = &[b"offer", o.maker.as_ref(), &seed, &[o.bump]];
        let signer = &[seeds];
        transfer(
            CpiContext::new_with_signer(
                tp,
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.taker_token_a.to_account_info(),
                    authority: ctx.accounts.offer.to_account_info(),
                },
                signer,
            ),
            o.amount_a,
        )?;
        close_account(CpiContext::new_with_signer(
            tp,
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.maker.to_account_info(),
                authority: ctx.accounts.offer.to_account_info(),
            },
            signer,
        ))?;
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let o = &ctx.accounts.offer;
        require_keys_eq!(o.maker, ctx.accounts.maker.key(), EscrowError::WrongMaker);
        require_keys_eq!(o.vault, ctx.accounts.vault.key(), EscrowError::WrongVault);
        require!(ctx.accounts.maker_token_a.mint == o.mint_a, EscrowError::WrongMint);
        let tp = ctx.accounts.token_program.key();
        let seed = o.seed.to_le_bytes();
        let seeds: &[&[u8]] = &[b"offer", o.maker.as_ref(), &seed, &[o.bump]];
        let signer = &[seeds];
        transfer(
            CpiContext::new_with_signer(
                tp,
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.maker_token_a.to_account_info(),
                    authority: ctx.accounts.offer.to_account_info(),
                },
                signer,
            ),
            o.amount_a,
        )?;
        close_account(CpiContext::new_with_signer(
            tp,
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.maker.to_account_info(),
                authority: ctx.accounts.offer.to_account_info(),
            },
            signer,
        ))?;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub maker: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub vault: Pubkey,
    pub amount_a: u64,
    pub want_b: u64,
    pub seed: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Make<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(init, payer = maker, space = 8 + Offer::INIT_SPACE, seeds = [b"offer", maker.key().as_ref(), &seed.to_le_bytes()], bump)]
    pub offer: Account<'info, Offer>,
    #[account(mut)]
    pub maker_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Take<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    /// CHECK: compared against offer.maker
    #[account(mut)]
    pub maker: UncheckedAccount<'info>,
    #[account(mut, close = maker)]
    pub offer: Account<'info, Offer>,
    #[account(mut)]
    pub taker_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub taker_token_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub maker_token_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(mut, close = maker)]
    pub offer: Account<'info, Offer>,
    #[account(mut)]
    pub maker_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum EscrowError {
    #[msg("Amounts must be greater than zero")]
    ZeroAmount,
    #[msg("Vault must be an empty token account owned by the offer")]
    BadVault,
    #[msg("Maker does not match the offer")]
    WrongMaker,
    #[msg("Vault does not match the offer")]
    WrongVault,
    #[msg("Token account has the wrong mint")]
    WrongMint,
    #[msg("Maker's token account is not owned by the maker")]
    WrongRecipient,
}
