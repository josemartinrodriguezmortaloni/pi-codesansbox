"""Inline matplotlib backend: `plt.show()` sends every open figure to the cell output.

Selected by the host with MPLBACKEND=module://pi_inline_backend. Rendering uses Agg.
"""

import sys

from matplotlib._pylab_helpers import Gcf
from matplotlib.backend_bases import FigureManagerBase
from matplotlib.backends.backend_agg import FigureCanvasAgg

FigureCanvas = FigureCanvasAgg
FigureManager = FigureManagerBase


def show(*args, **kwargs):
    kernel = sys.modules["__pi_kernel__"]
    for manager in Gcf.get_all_fig_managers():
        kernel.emit_figure(manager.canvas.figure)
    Gcf.destroy_all()
