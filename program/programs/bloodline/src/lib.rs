use anchor_lang::prelude::*;
use anchor_lang::system_program;
use solana_program::instruction::{AccountMeta, Instruction};

declare_id!("B1ood1ine1111111111111111111111111111111111");

// Known Jupiter v6 program ID
const JUPITER_V6: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

#[program]
pub mod bloodline {
    use super::*;

    /// One-time: initialize protocol config
    pub fn initialize(ctx: Context<Initialize>, operator: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.operator = operator;
        config.protocol_wallet = ctx.accounts.authority.key();
        config.royalty_bps = 1000; // 10%
        config.protocol_fee_bps = 200; // 2%
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Update operator or protocol wallet
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_operator: Option<Pubkey>,
        new_protocol_wallet: Option<Pubkey>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(op) = new_operator {
            config.operator = op;
        }
        if let Some(pw) = new_protocol_wallet {
            config.protocol_wallet = pw;
        }
        Ok(())
    }

    /// Create a new agent vault. Owner deposits initial SOL in the same tx.
    pub fn create_agent(
        ctx: Context<CreateAgent>,
        agent_id: String,
        generation: u8,
        dna_hash: [u8; 32],
        deposit_lamports: u64,
    ) -> Result<()> {
        require!(agent_id.len() <= 32, BloodlineError::IdTooLong);
        require!(deposit_lamports > 0, BloodlineError::ZeroDeposit);

        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.agent_id = agent_id;
        vault.generation = generation;
        vault.dna_hash = dna_hash;
        vault.balance = deposit_lamports;
        vault.total_pnl = 0;
        vault.total_royalties_paid = 0;
        vault.status = AgentStatus::Alive;
        vault.created_at = Clock::get()?.unix_timestamp;
        vault.bump = ctx.bumps.vault;

        // Set parent (default = no parent for genesis)
        vault.parent_vault = if let Some(parent) = &ctx.remaining_accounts.first() {
            if generation > 0 { parent.key() } else { Pubkey::default() }
        } else {
            Pubkey::default()
        };

        let agent_id_clone = vault.agent_id.clone();
        let owner_key = vault.owner;

        // Transfer SOL from owner to vault PDA
        let vault_info = vault.to_account_info();
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: vault_info,
                },
            ),
            deposit_lamports,
        )?;

        emit!(AgentCreated {
            agent_id: agent_id_clone,
            owner: owner_key,
            generation,
            deposit: deposit_lamports,
        });

        Ok(())
    }

    /// Owner deposits more SOL into their agent vault
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, BloodlineError::ZeroDeposit);
        require!(
            ctx.accounts.vault.status == AgentStatus::Alive,
            BloodlineError::AgentNotAlive
        );

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        ctx.accounts.vault.balance += amount;
        Ok(())
    }

    /// Operator executes a Jupiter swap on behalf of an agent vault.
    /// The swap instruction data and all route accounts are passed externally.
    /// Our program signs with the vault PDA so Jupiter can move funds.
    pub fn execute_swap(
        ctx: Context<ExecuteSwap>,
        swap_data: Vec<u8>,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        let vault = &ctx.accounts.vault;

        // Only operator can execute trades
        require!(
            ctx.accounts.operator.key() == config.operator,
            BloodlineError::Unauthorized
        );

        // Agent must be alive
        require!(
            vault.status == AgentStatus::Alive,
            BloodlineError::AgentNotAlive
        );

        // Verify the target program is Jupiter
        require!(
            ctx.accounts.jupiter_program.key() == JUPITER_V6,
            BloodlineError::InvalidJupiterProgram
        );

        // Record vault balance before swap
        let balance_before = ctx.accounts.vault.to_account_info().lamports();

        // Build CPI to Jupiter using remaining_accounts
        let vault_key = ctx.accounts.vault.key();
        let accounts: Vec<AccountMeta> = ctx.remaining_accounts
            .iter()
            .map(|a| {
                let is_vault = a.key() == vault_key;
                if a.is_writable {
                    AccountMeta::new(a.key(), a.is_signer || is_vault)
                } else {
                    AccountMeta::new_readonly(a.key(), a.is_signer || is_vault)
                }
            })
            .collect();

        let ix = Instruction {
            program_id: JUPITER_V6,
            accounts,
            data: swap_data,
        };

        let vault_seeds = &[
            b"vault" as &[u8],
            ctx.accounts.vault.agent_id.as_bytes(),
            &[ctx.accounts.vault.bump],
        ];

        solana_program::program::invoke_signed(
            &ix,
            ctx.remaining_accounts,
            &[vault_seeds],
        )?;

        // Record balance change
        let balance_after = ctx.accounts.vault.to_account_info().lamports();
        let pnl_change = balance_after as i64 - balance_before as i64;

        // Update vault state
        let vault_mut = &mut ctx.accounts.vault;
        vault_mut.balance = balance_after.saturating_sub(
            Rent::get()?.minimum_balance(vault_mut.to_account_info().data_len())
        );
        vault_mut.total_pnl += pnl_change;

        emit!(TradeExecuted {
            agent_id: vault_mut.agent_id.clone(),
            pnl_change,
            balance_after: vault_mut.balance,
        });

        // Kill agent if lost >90% of deposits
        if vault_mut.balance < vault_mut.balance / 10 {
            vault_mut.status = AgentStatus::Dead;
            emit!(AgentDied {
                agent_id: vault_mut.agent_id.clone(),
                final_pnl: vault_mut.total_pnl,
            });
        }

        Ok(())
    }

    /// Owner withdraws SOL. Pending royalties are auto-deducted first.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let vault = &ctx.accounts.vault;
        let config = &ctx.accounts.config;

        // Calculate pending royalties
        let pending_royalties = if vault.total_pnl > 0 && vault.parent_vault != Pubkey::default() {
            let owed = (vault.total_pnl as u64)
                .checked_mul(config.royalty_bps as u64)
                .unwrap_or(0) / 10000;
            owed.saturating_sub(vault.total_royalties_paid)
        } else {
            0
        };

        // Calculate protocol fee
        let pending_protocol = if vault.total_pnl > 0 {
            let owed = (vault.total_pnl as u64)
                .checked_mul(config.protocol_fee_bps as u64)
                .unwrap_or(0) / 10000;
            owed.saturating_sub(vault.total_royalties_paid) // simplified — track separately in production
        } else {
            0
        };

        // Available balance
        let rent = Rent::get()?.minimum_balance(vault.to_account_info().data_len());
        let available = vault.to_account_info().lamports()
            .saturating_sub(rent)
            .saturating_sub(pending_royalties)
            .saturating_sub(pending_protocol);

        require!(amount <= available, BloodlineError::InsufficientBalance);

        // Transfer from PDA to owner
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += amount;

        ctx.accounts.vault.balance = ctx.accounts.vault.to_account_info().lamports()
            .saturating_sub(rent);

        emit!(Withdrawal {
            agent_id: ctx.accounts.vault.agent_id.clone(),
            owner: ctx.accounts.owner.key(),
            amount,
        });

        Ok(())
    }

    /// Emergency withdraw: owner pulls everything. Agent dies immediately.
    pub fn emergency_withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let rent = Rent::get()?.minimum_balance(vault.to_account_info().data_len());
        let all = vault.to_account_info().lamports().saturating_sub(rent);

        if all > 0 {
            **vault.to_account_info().try_borrow_mut_lamports()? -= all;
            **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += all;
        }

        vault.status = AgentStatus::Dead;
        vault.balance = 0;

        emit!(AgentDied {
            agent_id: vault.agent_id.clone(),
            final_pnl: vault.total_pnl,
        });

        Ok(())
    }

    /// Distribute royalty from child vault to parent vault.
    /// Called by operator after profitable trades.
    pub fn distribute_royalty(ctx: Context<DistributeRoyalty>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;

        // Only operator
        require!(
            ctx.accounts.operator.key() == config.operator,
            BloodlineError::Unauthorized
        );

        // Verify parent relationship
        require!(
            ctx.accounts.child_vault.parent_vault == ctx.accounts.parent_vault.key(),
            BloodlineError::NotParent
        );

        // Verify amount doesn't exceed owed royalties
        let child = &ctx.accounts.child_vault;
        if child.total_pnl > 0 {
            let owed = (child.total_pnl as u64)
                .checked_mul(config.royalty_bps as u64)
                .unwrap_or(0) / 10000;
            let remaining = owed.saturating_sub(child.total_royalties_paid);
            require!(amount <= remaining, BloodlineError::RoyaltyExceedsOwed);
        } else {
            return Err(BloodlineError::NoProfitForRoyalty.into());
        }

        // Transfer lamports from child vault PDA to parent vault PDA
        **ctx.accounts.child_vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.parent_vault.to_account_info().try_borrow_mut_lamports()? += amount;

        // Update state
        ctx.accounts.child_vault.total_royalties_paid += amount;
        ctx.accounts.child_vault.balance = ctx.accounts.child_vault.balance.saturating_sub(amount);
        ctx.accounts.parent_vault.balance += amount;

        emit!(RoyaltyPaid {
            from_agent: ctx.accounts.child_vault.agent_id.clone(),
            to_agent: ctx.accounts.parent_vault.agent_id.clone(),
            amount,
        });

        Ok(())
    }

    /// Close a dead agent vault, return remaining rent to owner
    pub fn close_agent(ctx: Context<CloseAgent>) -> Result<()> {
        require!(
            ctx.accounts.vault.status == AgentStatus::Dead,
            BloodlineError::AgentNotDead
        );
        // Anchor will close the account and return lamports to owner
        Ok(())
    }
}

// ============================================================
// ACCOUNTS
// ============================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub struct CreateAgent<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + AgentVault::INIT_SPACE,
        seeds = [b"vault", agent_id.as_bytes()],
        bump,
    )]
    pub vault: Account<'info, AgentVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.agent_id.as_bytes()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, AgentVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"vault", vault.agent_id.as_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,
    pub operator: Signer<'info>,
    /// CHECK: Verified against JUPITER_V6 constant
    pub jupiter_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"vault", vault.agent_id.as_bytes()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, AgentVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct DistributeRoyalty<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"vault", child_vault.agent_id.as_bytes()],
        bump = child_vault.bump,
    )]
    pub child_vault: Account<'info, AgentVault>,
    #[account(
        mut,
        seeds = [b"vault", parent_vault.agent_id.as_bytes()],
        bump = parent_vault.bump,
    )]
    pub parent_vault: Account<'info, AgentVault>,
    pub operator: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseAgent<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.agent_id.as_bytes()],
        bump = vault.bump,
        has_one = owner,
        close = owner,
    )]
    pub vault: Account<'info, AgentVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

// ============================================================
// STATE
// ============================================================

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,        // Admin who can update config
    pub operator: Pubkey,         // Cron signer who executes trades
    pub protocol_wallet: Pubkey,  // Where protocol fees go
    pub royalty_bps: u16,         // 1000 = 10%
    pub protocol_fee_bps: u16,   // 200 = 2%
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AgentVault {
    pub owner: Pubkey,
    pub parent_vault: Pubkey,     // Pubkey::default() if genesis
    #[max_len(32)]
    pub agent_id: String,
    pub generation: u8,
    pub dna_hash: [u8; 32],
    pub balance: u64,             // Tracked balance (lamports)
    pub total_pnl: i64,          // Lifetime PnL (lamports, can be negative)
    pub total_royalties_paid: u64,
    pub status: AgentStatus,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum AgentStatus {
    Alive,
    Dead,
    Idle,
}

// ============================================================
// EVENTS
// ============================================================

#[event]
pub struct AgentCreated {
    pub agent_id: String,
    pub owner: Pubkey,
    pub generation: u8,
    pub deposit: u64,
}

#[event]
pub struct TradeExecuted {
    pub agent_id: String,
    pub pnl_change: i64,
    pub balance_after: u64,
}

#[event]
pub struct AgentDied {
    pub agent_id: String,
    pub final_pnl: i64,
}

#[event]
pub struct Withdrawal {
    pub agent_id: String,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RoyaltyPaid {
    pub from_agent: String,
    pub to_agent: String,
    pub amount: u64,
}

// ============================================================
// ERRORS
// ============================================================

#[error_code]
pub enum BloodlineError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Agent ID too long (max 32 chars)")]
    IdTooLong,
    #[msg("Deposit must be greater than 0")]
    ZeroDeposit,
    #[msg("Agent is not alive")]
    AgentNotAlive,
    #[msg("Agent is not dead")]
    AgentNotDead,
    #[msg("Invalid Jupiter program")]
    InvalidJupiterProgram,
    #[msg("Insufficient balance for withdrawal")]
    InsufficientBalance,
    #[msg("Not the parent of this agent")]
    NotParent,
    #[msg("Royalty amount exceeds what is owed")]
    RoyaltyExceedsOwed,
    #[msg("No profit to distribute royalties from")]
    NoProfitForRoyalty,
}
