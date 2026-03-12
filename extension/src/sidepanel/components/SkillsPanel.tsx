import { useRef, useEffect } from 'react';

export interface SkillsConfig {
  promptTemplate: string;
  colorTemplate: string;
}

interface SkillsPanelProps {
  open: boolean;
  config: SkillsConfig;
  onChange: (config: SkillsConfig) => void;
  onClose: () => void;
}

const PROMPT_TEMPLATES = [
  { id: 'none', label: 'None' },
  { id: 'retro', label: 'Retro' },
  { id: 'concert', label: 'Concert' },
  { id: 'cinema', label: 'Cinema' },
  { id: 'anime', label: 'Anime' },
  { id: 'watercolor', label: 'Watercolor' },
  { id: 'pixel-art', label: 'Pixel Art' },
  { id: 'poster', label: 'Poster' },
];

const COLOR_TEMPLATES = [
  { id: 'none', label: 'None', colors: [] },
  {
    id: 'retro-warm',
    label: 'Retro Warm',
    colors: ['#D4A574', '#C1694F', '#8B4513', '#F5DEB3', '#CD853F'],
  },
  {
    id: 'neon-night',
    label: 'Neon Night',
    colors: ['#FF006E', '#8338EC', '#3A86FF', '#06D6A0', '#FFBE0B'],
  },
  {
    id: 'cinema-mood',
    label: 'Cinema',
    colors: ['#1A1A2E', '#16213E', '#0F3460', '#E94560', '#533483'],
  },
  {
    id: 'pastel-dream',
    label: 'Pastel',
    colors: ['#FFB5E8', '#B5DEFF', '#D5AAFF', '#BFFCC6', '#FFF5BA'],
  },
  {
    id: 'earth-tone',
    label: 'Earth',
    colors: ['#606C38', '#283618', '#FEFAE0', '#DDA15E', '#BC6C25'],
  },
  {
    id: 'monochrome',
    label: 'Mono',
    colors: ['#111111', '#444444', '#888888', '#CCCCCC', '#F5F5F5'],
  },
];

export function SkillsPanel({ open, config, onChange, onClose }: SkillsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        const trigger = (e.target as Element)?.closest('.skills-trigger');
        if (!trigger) onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, onClose]);

  return (
    <div className={`skills-panel ${open ? 'open' : ''}`} ref={panelRef}>
      <div className="skills-header">
        <span className="skills-title">Skills</span>
      </div>

      <div className="skills-body">
        {/* Prompt Template */}
        <div className="skills-section">
          <label className="skills-label">Prompt Template</label>
          <div className="skills-chips">
            {PROMPT_TEMPLATES.map((t) => (
              <button
                key={t.id}
                className={`skills-chip ${config.promptTemplate === t.id ? 'active' : ''}`}
                onClick={() => onChange({ ...config, promptTemplate: t.id })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Color Template */}
        <div className="skills-section">
          <label className="skills-label">Color Palette</label>
          <div className="skills-palette-list">
            {COLOR_TEMPLATES.map((p) => (
              <button
                key={p.id}
                className={`skills-palette ${config.colorTemplate === p.id ? 'active' : ''}`}
                onClick={() => onChange({ ...config, colorTemplate: p.id })}
              >
                {p.colors.length > 0 ? (
                  <div className="skills-swatches">
                    {p.colors.map((c, i) => (
                      <span
                        key={i}
                        className="skills-swatch"
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="skills-swatches skills-swatches-empty">
                    <span className="skills-swatch-none" />
                  </div>
                )}
                <span className="skills-palette-label">{p.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Build skill context string for prompt
export function buildSkillContext(config: SkillsConfig): string {
  const parts: string[] = [];

  if (config.promptTemplate && config.promptTemplate !== 'none') {
    const template = PROMPT_TEMPLATES.find((t) => t.id === config.promptTemplate);
    if (template) {
      parts.push(`Style: hãy áp dụng phong cách "${template.label}" cho ảnh.`);
    }
  }

  if (config.colorTemplate && config.colorTemplate !== 'none') {
    const palette = COLOR_TEMPLATES.find((p) => p.id === config.colorTemplate);
    if (palette && palette.colors.length > 0) {
      parts.push(
        `Bảng màu: sử dụng bảng màu "${palette.label}" gồm các màu ${palette.colors.join(', ')}.`
      );
    }
  }

  return parts.join('\n');
}
