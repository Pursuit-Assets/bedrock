import React, { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  Alert,
} from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import toast from 'react-hot-toast';

import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api';

type IntakeType = 'bug' | 'feature';
type Priority = 'urgent' | 'high' | 'medium' | 'low';

// Dropdown values kept in sync with ALLOWED_COMPONENTS in
// routes/platform_intake.py — edit both if you add/remove items.
// Submissions land in public.pd_tickets with source='bedrock' and the
// chosen component shown as a **Component:** header at the top of the
// ticket description.
const COMPONENTS: { value: string; label: string }[] = [
  { value: 'priorities', label: 'Priorities' },
  { value: 'details', label: 'Details (tables)' },
  { value: 'progress', label: 'Progress' },
  { value: 'opportunities', label: 'Opportunities' },
  { value: 'accounts', label: 'Accounts' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'leads', label: 'Leads' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'salesforce_sync', label: 'Salesforce sync' },
  { value: 'other', label: 'Other' },
];

const PRIORITIES: { value: Priority; label: string }[] = [
  { value: 'urgent', label: 'Urgent — blocks me right now' },
  { value: 'high', label: 'High — blocks me this week' },
  { value: 'medium', label: 'Medium — important, workaround exists' },
  { value: 'low', label: 'Low — nice to have' },
];

const ACCEPT_ATTR =
  'image/png,image/jpeg,image/gif,image/webp,video/quicktime,video/mp4,application/pdf';

const MAX_UPLOAD_MB = 25;

const PlatformIntake: React.FC = () => {
  const { user } = useAuth();

  const [type, setType] = useState<IntakeType>('bug');
  const [reporterName, setReporterName] = useState(user?.name || '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [component, setComponent] = useState('');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [justification, setJustification] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lastSubmission, setLastSubmission] = useState<{
    id: string;
    uploadUrl: string | null;
  } | null>(null);

  const reporterEmail = user?.email || '';

  const disabled = useMemo(() => {
    if (submitting) return true;
    if (!title.trim() || !description.trim()) return true;
    if (!component) return true;
    if (!priority) return true;
    return false;
  }, [submitting, title, description, component, priority]);

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setComponent('');
    setPriority('');
    setJustification('');
    setAttachment(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    if (file && file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      toast.error(`File is larger than ${MAX_UPLOAD_MB} MB — please attach a smaller version.`);
      e.target.value = '';
      setAttachment(null);
      return;
    }
    setAttachment(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;

    const formData = new FormData();
    formData.append('type', type);
    formData.append('title', title.trim());
    formData.append('description', description.trim());
    formData.append('platform_component', component);
    formData.append('recommended_prioritization', priority);
    formData.append('prioritization_justification', justification.trim());
    formData.append('reporter_name', reporterName.trim());
    if (attachment) {
      formData.append('attachment', attachment);
    }

    setSubmitting(true);
    try {
      const response = await apiService.submitPlatformIntake(formData);
      const data = response.data as { id: string; upload_url: string | null };
      toast.success(
        type === 'bug'
          ? 'Bug submitted. Thank you!'
          : 'Feature request submitted. Thank you!'
      );
      setLastSubmission({ id: data.id, uploadUrl: data.upload_url });
      resetForm();
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || 'Submission failed.';
      toast.error(String(detail));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 820, mx: 'auto', py: 0.5 }}>
      <Typography variant="h6" fontWeight={700} sx={{ mb: 0.5 }}>
        Report a bug or request a feature
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
        Submissions go to the product team alongside intake from the rest of the Pursuit platform. Screenshots welcome.
      </Typography>

      {lastSubmission && (
        <Alert
          severity="success"
          sx={{ mb: 1, py: 0.25 }}
          onClose={() => setLastSubmission(null)}
        >
          Submitted as <strong>#{lastSubmission.id.slice(0, 8)}</strong>
          {lastSubmission.uploadUrl ? ' (attachment uploaded).' : '.'}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Box component="form" onSubmit={handleSubmit}>
          <Stack spacing={1.5}>
            {/* Row 1: Type toggle */}
            <ToggleButtonGroup
              color="primary"
              exclusive
              size="small"
              value={type}
              onChange={(_, v) => v && setType(v)}
              aria-label="Submission type"
            >
              <ToggleButton value="bug" sx={{ px: 2 }}>
                <BugReportOutlinedIcon fontSize="small" sx={{ mr: 0.5 }} />
                Bug
              </ToggleButton>
              <ToggleButton value="feature" sx={{ px: 2 }}>
                <LightbulbOutlinedIcon fontSize="small" sx={{ mr: 0.5 }} />
                Feature
              </ToggleButton>
            </ToggleButtonGroup>

            {/* Row 2: Reporter email (readonly) + name */}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                label="Your email"
                value={reporterEmail}
                InputProps={{ readOnly: true }}
                size="small"
                fullWidth
              />
              <TextField
                label="Your name"
                value={reporterName}
                onChange={(e) => setReporterName(e.target.value)}
                size="small"
                fullWidth
              />
            </Stack>

            {/* Row 3: Title */}
            <TextField
              label={type === 'bug' ? 'Short summary of the bug' : 'Short summary of the feature'}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              size="small"
              fullWidth
              inputProps={{ maxLength: 200 }}
            />

            {/* Row 4: Description */}
            <TextField
              label={
                type === 'bug'
                  ? 'What happened? What did you expect? Steps to reproduce?'
                  : 'What would you like to see, and why?'
              }
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              multiline
              minRows={3}
              maxRows={4}
              size="small"
              fullWidth
              inputProps={{ maxLength: 5000 }}
            />

            {/* Row 5: Attachment — surfaced inline so folks actually add screenshots */}
            <Box
              sx={{
                border: '1px dashed',
                borderColor: 'divider',
                borderRadius: 1,
                px: 1.5,
                py: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                flexWrap: 'wrap',
              }}
            >
              <CloudUploadIcon fontSize="small" color="action" />
              <Box sx={{ flex: 1, minWidth: 180 }}>
                <Typography variant="body2" fontWeight={500}>
                  Screenshot or recording (optional)
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  PNG, JPG, GIF, WebP, MOV, MP4, PDF · Max {MAX_UPLOAD_MB} MB
                </Typography>
              </Box>
              {attachment && (
                <Chip
                  label={`${attachment.name} (${Math.round(attachment.size / 1024)} KB)`}
                  onDelete={() => setAttachment(null)}
                  size="small"
                />
              )}
              <Button component="label" variant="outlined" size="small">
                {attachment ? 'Replace file' : 'Choose file'}
                <input hidden type="file" accept={ACCEPT_ATTR} onChange={handleFileChange} />
              </Button>
            </Box>

            {/* Row 6: Component + Priority side-by-side */}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <FormControl fullWidth required size="small">
                <InputLabel id="intake-component-label">Which part of Bedrock?</InputLabel>
                <Select
                  labelId="intake-component-label"
                  label="Which part of Bedrock?"
                  value={component}
                  onChange={(e) => setComponent(e.target.value)}
                >
                  {COMPONENTS.map((c) => (
                    <MenuItem key={c.value} value={c.value}>
                      {c.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl fullWidth required size="small">
                <InputLabel id="intake-priority-label">Recommended priority</InputLabel>
                <Select
                  labelId="intake-priority-label"
                  label="Recommended priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as Priority)}
                >
                  {PRIORITIES.map((p) => (
                    <MenuItem key={p.value} value={p.value}>
                      {p.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>

            {/* Row 6: Justification */}
            <TextField
              label="Why that priority? (optional)"
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              multiline
              minRows={2}
              maxRows={2}
              size="small"
              fullWidth
              inputProps={{ maxLength: 2000 }}
            />

            {/* Row 8: Action buttons */}
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button type="button" onClick={resetForm} disabled={submitting} size="small">
                Clear
              </Button>
              <Button type="submit" variant="contained" disabled={disabled} size="small">
                {submitting ? 'Submitting…' : type === 'bug' ? 'Submit bug' : 'Submit request'}
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Paper>
    </Box>
  );
};

export default PlatformIntake;
