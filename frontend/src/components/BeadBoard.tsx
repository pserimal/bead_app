import { useRef, useEffect, useCallback } from 'react';

interface CellData {
  id: number;
  blueprint_id: number;
  row_idx: number;
  col_idx: number;
  bead_code: string | null;
  pixel_color: string | null;
}

interface BeadBoardProps {
  cells: CellData[];
  gridRows: number;
  gridCols: number;
  highlightCode: string | null;
  scale: number;
  rotation: number;
  panOffset?: { x: number; y: number };
  onPanChange?: (offset: { x: number; y: number }) => void;
  onScaleChange?: (scale: number) => void;
  onCellClick: (cell: CellData) => void;
  colorMap: Record<string, string>;
}

const CELL_SIZE = 40;

export default function BeadBoard({
  cells,
  gridRows,
  gridCols,
  highlightCode,
  scale = 1,
  rotation,
  panOffset = { x: 0, y: 0 },
  onPanChange,
  onScaleChange,
  onCellClick,
  colorMap,
}: BeadBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchRef = useRef<{dist: number | null}>({dist: null});
  const isDragging = useRef(false);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const dragStartPos = useRef<{ x: number; y: number; dragged: boolean }>({ x: 0, y: 0, dragged: false });

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale > 1) {
      isDragging.current = true;
      lastMousePos.current = { x: e.clientX, y: e.clientY };
      dragStartPos.current = { x: e.clientX, y: e.clientY, dragged: false };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging.current && onPanChange) {
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      lastMousePos.current = { x: e.clientX, y: e.clientY };
      onPanChange({ x: panOffset.x + dx, y: panOffset.y + dy });
      dragStartPos.current.dragged = true;
    }
  };

  const handleMouseUp = () => {
    isDragging.current = false;
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const container = containerRef.current;
    if (!container) return;

    const dpr = window.devicePixelRatio || 1;
    const containerW = Math.floor(container.clientWidth);
    const gridW = gridCols * CELL_SIZE;
    const gridH = gridRows * CELL_SIZE;
    const renderedW = gridW * scale;
    const renderedH = gridH * scale;
    const canvasW = Math.max(containerW, Math.floor(renderedW));
    const canvasH = Math.floor(renderedH);

    canvas.width = canvasW * dpr;
    canvas.height = canvasH * dpr;
    canvas.style.width = `${canvasW}px`;
    canvas.style.height = `${canvasH}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasW, canvasH);

    const offsetX = -gridW / 2;
    const offsetY = -gridH / 2;

    ctx.save();
    ctx.translate(canvasW / 2 + panOffset.x, canvasH / 2 + panOffset.y);
    ctx.scale(scale, scale);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(offsetX, offsetY);

    // Draw grid background
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, gridW, gridH);

    // Draw grid outline (outer border)
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, gridW, gridH);

    // Draw each cell
    for (const cell of cells) {
      const x = cell.col_idx * CELL_SIZE;
      const y = cell.row_idx * CELL_SIZE;
      const cellKey = cell.bead_code || cell.pixel_color || '';
      const isHighlighted = !highlightCode || cellKey === highlightCode;
      const alpha = isHighlighted ? 1.0 : 0.15;

      const hex = cell.bead_code ? colorMap[cell.bead_code] : (cell.pixel_color || null);

      // Cell background
      ctx.globalAlpha = alpha;
      ctx.fillStyle = hex || '#e2e8f0';
      ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);

      // Grid border
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, CELL_SIZE, CELL_SIZE);

      // Bead code text
      if (cell.bead_code) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = hex ? '#ffffff' : '#334155';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(cell.bead_code, x + CELL_SIZE / 2, y + CELL_SIZE / 2);
      }
    }

    ctx.restore();
  }, [cells, gridRows, gridCols, highlightCode, scale, rotation, panOffset, colorMap]);

  // Click handler: map canvas coords to cell (accounting for pan offset)
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragStartPos.current.dragged) {
      dragStartPos.current.dragged = false;
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const cx = (x - Math.floor(rect.width) / 2 - panOffset.x) / scale;
    const cy = (y - Math.floor(rect.height) / 2 - panOffset.y) / scale;
    const gridW = gridCols * CELL_SIZE;
    const gridH = gridRows * CELL_SIZE;
    const col = Math.floor((cx + gridW / 2) / CELL_SIZE);
    const row = Math.floor((cy + gridH / 2) / CELL_SIZE);
    const cell = cells.find(c => c.row_idx === row && c.col_idx === col);
    if (cell) onCellClick(cell);
  };

  useEffect(() => { draw(); }, [draw]);

  return (
    <div
      ref={containerRef}
      className="w-full min-h-full bg-slate-100 rounded-lg"
    >
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: scale > 1 ? 'grab' : 'pointer' }}
        onWheel={(e) => {
          e.preventDefault();
          const delta = e.deltaY > 0 ? -0.1 : 0.1;
          const newScale = Math.max(0.05, Math.min(5, scale + delta));
          if (onScaleChange) onScaleChange(newScale);
        }}
        onTouchStart={(e) => {
          if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            touchRef.current.dist = Math.sqrt(dx*dx + dy*dy);
          }
        }}
        onTouchMove={(e) => {
          if (e.touches.length === 2 && touchRef.current.dist) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const newDist = Math.sqrt(dx*dx + dy*dy);
            const delta = (newDist - touchRef.current.dist) / touchRef.current.dist;
            const newScale = Math.max(0.05, Math.min(5, scale + delta));
            touchRef.current.dist = newDist;
            if (onScaleChange) onScaleChange(newScale);
          }
        }}
        onTouchEnd={() => { touchRef.current.dist = null; }}
        className="cursor-pointer"
      />
    </div>
  );
}
