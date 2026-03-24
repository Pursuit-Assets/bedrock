import React from 'react';
import { Box, Button, Chip, Typography } from '@mui/material';

export interface ClarificationOption {
  label: string;
  value: string;
  description?: string | null;
}

export interface ChatMessageData {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tier?: string | null;
  cost_usd?: number;
  elapsed_seconds?: number;
  requires_clarification?: boolean;
  clarification_options?: ClarificationOption[];
  redirect_target?: string | null;
}

interface ChatMessageProps {
  message: ChatMessageData;
  onOptionClick?: (value: string) => void;
}

const TIER_COLORS: Record<string, 'default' | 'primary' | 'secondary' | 'warning' | 'info' | 'success'> = {
  T0: 'success',
  'T0.5': 'info',
  T1: 'primary',
  T2: 'secondary',
  T3: 'warning',
  redirect: 'default',
};

const ChatMessage: React.FC<ChatMessageProps> = ({ message, onOptionClick }) => {
  const isUser = message.role === 'user';

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        mb: 1.5,
      }}
    >
      <Box
        sx={{
          maxWidth: '85%',
          p: 1.5,
          borderRadius: 2,
          bgcolor: isUser ? 'primary.main' : 'grey.100',
          color: isUser ? 'primary.contrastText' : 'text.primary',
        }}
      >
        {/* Routing badge for assistant messages */}
        {!isUser && message.tier && (
          <Box sx={{ mb: 0.5 }}>
            <Chip
              label={
                message.tier +
                (message.elapsed_seconds != null ? ` \u00b7 ${message.elapsed_seconds.toFixed(1)}s` : '') +
                (message.cost_usd ? ` \u00b7 $${message.cost_usd.toFixed(3)}` : !message.cost_usd ? ' \u00b7 free' : '')
              }
              size="small"
              color={TIER_COLORS[message.tier] || 'default'}
              variant="outlined"
              sx={{ height: 20, fontSize: '0.7rem' }}
            />
          </Box>
        )}

        {/* Message content */}
        <Typography
          variant="body2"
          sx={{ whiteSpace: 'pre-wrap', '& strong, & b': { fontWeight: 600 } }}
          dangerouslySetInnerHTML={{
            __html: message.content
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
              .replace(/\n/g, '<br />'),
          }}
        />

        {/* Disambiguation options */}
        {!isUser && message.requires_clarification && message.clarification_options && (
          <Box sx={{ mt: 1.5, display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            {message.clarification_options.map((opt) => (
              <Button
                key={opt.value}
                variant="outlined"
                size="small"
                onClick={() => onOptionClick?.(opt.value)}
                sx={{
                  textTransform: 'none',
                  textAlign: 'left',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  py: 0.75,
                  px: 1.5,
                }}
              >
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {opt.label}
                </Typography>
                {opt.description && (
                  <Typography variant="caption" color="text.secondary">
                    {opt.description}
                  </Typography>
                )}
              </Button>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
};

export default ChatMessage;
