// Anchor twin of test/fixtures/borsh-profile.ts: a #[max_len] String and Vec and an Option before fixed fields, so the
// @layout borsh test can check that both write the same bytes and that each can take over the other's accounts.
use anchor_lang::prelude::*;

declare_id!("EaiwmXTVEwU6sh1wAizeXHmPkHS4s6HaHr4EX3vZ6kJq");

#[program]
pub mod anchor_profile {
    use super::*;

    pub fn create(ctx: Context<Create>, name: String) -> Result<()> {
        require!(name.len() <= 32, ProfileError::Full);
        let p = &mut ctx.accounts.profile;
        p.bump = ctx.bumps.profile;
        p.owner = ctx.accounts.owner.key();
        p.name = name;
        Ok(())
    }

    pub fn bump(ctx: Context<Owned>, by: u64) -> Result<()> {
        let p = &mut ctx.accounts.profile;
        p.score = p.score.checked_add(by).unwrap();
        p.updated = p.updated.checked_add(1).unwrap();
        Ok(())
    }

    pub fn rename(ctx: Context<Owned>, name: String) -> Result<()> {
        require!(name.len() <= 32, ProfileError::Full);
        ctx.accounts.profile.name = name;
        Ok(())
    }

    pub fn add_tag(ctx: Context<Owned>, tag: u64) -> Result<()> {
        let p = &mut ctx.accounts.profile;
        require!(p.tags.len() < 8, ProfileError::Full);
        p.tags.push(tag);
        Ok(())
    }

    pub fn set_badge(ctx: Context<Owned>, badge: Option<u64>) -> Result<()> {
        ctx.accounts.profile.badge = badge;
        Ok(())
    }

    pub fn total(ctx: Context<Read>) -> Result<u64> {
        let p = &ctx.accounts.profile;
        let mut t = p.score;
        for x in &p.tags {
            t = t.checked_add(*x).unwrap();
        }
        Ok(t)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Profile {
    pub owner: Pubkey,
    pub bump: u8,
    #[max_len(32)]
    pub name: String,
    #[max_len(8)]
    pub tags: Vec<u64>,
    pub badge: Option<u64>,
    pub score: u64,
    pub updated: i64,
}

#[derive(Accounts)]
pub struct Create<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Profile::INIT_SPACE, seeds = [b"profile", owner.key().as_ref()], bump)]
    pub profile: Account<'info, Profile>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Owned<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub profile: Account<'info, Profile>,
}

#[derive(Accounts)]
pub struct Read<'info> {
    pub profile: Account<'info, Profile>,
}

#[error_code]
pub enum ProfileError {
    Full,
}
