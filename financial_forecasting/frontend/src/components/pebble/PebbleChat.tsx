import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Box,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
  CircularProgress,
} from '@mui/material';
import { Send as SendIcon } from '@mui/icons-material';
import ChatMessage, { type ChatMessageData } from './ChatMessage';
import { pebbleService } from '../../services/pebbleApi';

/** Simple unique ID generator (avoids uuid dependency). */
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

interface PebbleChatProps {
  mode?: 'embedded' | 'floating';
  userEmail?: string;
  context?: {
    entity?: 'contact' | 'account' | 'opportunity';
    entityId?: string;
    entityName?: string;
  };
}

const MODE_OPTIONS = [
  { value: 'auto', label: 'Auto', hint: 'Pebble picks the right depth' },
  { value: 'quick', label: 'Quick Answer', hint: 'CRM lookups \u2014 instant, free' },
  { value: 'triage', label: 'ID & Triage', hint: '~5s, ~$0.005' },
  { value: 'structured', label: 'Structured Intel', hint: '~20s, ~$0.05' },
  { value: 'full', label: 'Full Research', hint: '~1min, ~$0.20' },
];

const PebbleChat: React.FC<PebbleChatProps> = ({
  mode: displayMode = 'embedded',
  userEmail,
}) => {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [input, setInput] = useState('');
  const [selectedMode, setSelectedMode] = useState('auto');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string>(() => uid());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const sendQuery = useCallback(
    async (query: string, selectedOption?: string) => {
      if (!query.trim() && !selectedOption) return;

      const userMessage: ChatMessageData = {
        id: uid(),
        role: 'user',
        content: selectedOption ? `Selected: ${query}` : query,
      };
      setMessages((prev) => [...prev, userMessage]);
      setInput('');
      setLoading(true);

      try {
        const response = await pebbleService.chatQuery({
          query: selectedOption || query,
          mode: selectedMode,
          conversation_id: conversationId,
          user_email: userEmail,
          selected_option: selectedOption || undefined,
        });

        const data = response.data;

        // Update conversation ID from server response
        if (data.conversation_id) {
          setConversationId(data.conversation_id);
        }

        const assistantMessage: ChatMessageData = {
          id: uid(),
          role: 'assistant',
          content: data.answer,
          tier:
            data.level === -1
              ? 'redirect'
              : data.level === 0
              ? 'T0'
              : data.level === 1
              ? 'T0.5'
              : data.level === 10
              ? 'T1'
              : data.level === 20
              ? 'T2'
              : data.level === 30
              ? 'T3'
              : `L${data.level}`,
          cost_usd: data.cost_usd,
          elapsed_seconds: data.elapsed_seconds,
          requires_clarification: data.requires_clarification,
          clarification_options: data.clarification_options || undefined,
          redirect_target: data.redirect_target,
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } catch (err: any) {
        const errorMessage: ChatMessageData = {
          id: uid(),
          role: 'assistant',
          content:
            err.response?.data?.detail ||
            'Something went wrong. Try rephrasing your query.',
          tier: undefined,
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setLoading(false);
      }
    },
    [conversationId, selectedMode, userEmail],
  );

  const handleOptionClick = useCallback(
    (value: string) => {
      sendQuery(value, value);
    },
    [sendQuery],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendQuery(input);
  };

  const handleNewConversation = () => {
    setMessages([]);
    setConversationId(uid());
  };

  const currentModeHint =
    MODE_OPTIONS.find((m) => m.value === selectedMode)?.hint || '';

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: displayMode === 'embedded' ? '100%' : 400,
        minHeight: 300,
      }}
    >
      {/* Chat messages area */}
      <Box
        sx={{
          flex: 1,
          overflowY: 'auto',
          px: 1,
          py: 1,
          maxHeight: 500,
          bgcolor: 'background.paper',
          borderRadius: 1,
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        {messages.length === 0 && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              minHeight: 120,
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Ask Pebble about prospects, CRM data, or pipeline status.
            </Typography>
          </Box>
        )}
        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            onOptionClick={handleOptionClick}
          />
        ))}
        {loading && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1 }}>
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">
              Pebble is thinking...
            </Typography>
          </Box>
        )}
        <div ref={messagesEndRef} />
      </Box>

      {/* Input area */}
      <Box
        component="form"
        onSubmit={handleSubmit}
        sx={{ display: 'flex', gap: 1, mt: 1, alignItems: 'flex-end' }}
      >
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel>Mode</InputLabel>
          <Select
            value={selectedMode}
            label="Mode"
            onChange={(e) => setSelectedMode(e.target.value)}
            size="small"
          >
            {MODE_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                {opt.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField
          fullWidth
          size="small"
          placeholder="Ask Pebble..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
          autoComplete="off"
        />
        <Button
          type="submit"
          variant="contained"
          size="small"
          disabled={loading || !input.trim()}
          sx={{ minWidth: 40, px: 1 }}
        >
          <SendIcon fontSize="small" />
        </Button>
      </Box>

      {/* Mode hint + new conversation */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mt: 0.5,
        }}
      >
        <Typography variant="caption" color="text.secondary">
          {currentModeHint}
        </Typography>
        {messages.length > 0 && (
          <Button size="small" onClick={handleNewConversation} sx={{ textTransform: 'none' }}>
            New conversation
          </Button>
        )}
      </Box>
    </Box>
  );
};

export default PebbleChat;
